import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const defaultMaxBytes = 49 * 1024 * 1024;
const defaultTimeoutMs = 90_000;
const defaultMaxLinks = 3;
const maxErrorLength = 4_000;

const numberFromEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const supportedHostname = (hostname, domain) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export const isSupportedVideoUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return false;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.toLowerCase();

  if (supportedHostname(hostname, 'instagram.com')) {
    return /^\/reels?\/[^/]+/.test(pathname);
  }

  if (!supportedHostname(hostname, 'tiktok.com')) return false;
  if (['vm.tiktok.com', 'vt.tiktok.com'].includes(hostname)) return pathname.length > 1;
  return pathname.includes('/video/') || pathname.startsWith('/t/');
};

export const extractSupportedVideoUrls = (text = '', limit = defaultMaxLinks) => {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) || [];
  const urls = matches
    .map((value) => value.replace(/[.,!?;:'"\]\)}]+$/g, ''))
    .filter(isSupportedVideoUrl);
  return Array.from(new Set(urls)).slice(0, Math.max(0, limit));
};

export class MediaDownloadError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'MediaDownloadError';
    this.code = code;
  }
}

const runProcess = ({ executable, args, timeoutMs, spawnProcess }) =>
  new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let child;
    let timer;

    try {
      child = spawnProcess(executable, args, {
        stdio: ['ignore', 'ignore', 'pipe']
      });
    } catch (error) {
      reject(new MediaDownloadError('spawn_failed', 'Не удалось запустить yt-dlp.', error));
      return;
    }

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxErrorLength);
    });

    child.once('error', (error) => {
      finish(() => reject(new MediaDownloadError('spawn_failed', 'Не удалось запустить yt-dlp.', error)));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new MediaDownloadError(
          'download_failed',
          `yt-dlp завершился с кодом ${code ?? signal ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`
        ));
      });
    });

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new MediaDownloadError('timeout', 'yt-dlp превысил допустимое время загрузки.')));
    }, timeoutMs);
  });

const downloadedFile = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.part') && !entry.name.endsWith('.ytdl'))
    .map((entry) => join(directory, entry.name));

  if (!files.length) throw new MediaDownloadError('missing_file', 'yt-dlp не создал видеофайл.');

  const sizes = await Promise.all(files.map(async (path) => ({ path, size: (await stat(path)).size })));
  return sizes.sort((left, right) => right.size - left.size)[0];
};

export const createMediaDownloadService = ({ env = process.env, spawnProcess = spawn } = {}) => {
  const executable = env.YT_DLP_PATH || 'yt-dlp';
  const cookiesFile = env.YT_DLP_COOKIES_FILE;
  const maxBytes = numberFromEnv(env.MEDIA_MAX_BYTES, defaultMaxBytes);
  const timeoutMs = numberFromEnv(env.MEDIA_DOWNLOAD_TIMEOUT_MS, defaultTimeoutMs);
  const maxLinks = Math.floor(numberFromEnv(env.MEDIA_MAX_LINKS, defaultMaxLinks));
  const enabled = env.MEDIA_DOWNLOADS_ENABLED !== 'false';

  const urlsFromMessage = (message = {}) =>
    enabled ? extractSupportedVideoUrls(message.text || message.caption || '', maxLinks) : [];

  const downloadVideo = async (url) => {
    if (!enabled) throw new MediaDownloadError('disabled', 'Загрузка видео отключена.');
    if (!isSupportedVideoUrl(url)) throw new MediaDownloadError('unsupported_url', 'Ссылка не поддерживается.');

    const directory = await mkdtemp(join(tmpdir(), 'ayaubot-media-'));
    try {
      const args = [
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
        '--format-sort', 'codec:h264',
        '--merge-output-format', 'mp4',
        '--recode-video', 'mp4',
        '--max-filesize', String(maxBytes),
        '--output', join(directory, 'video.%(ext)s')
      ];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      args.push('--', url);

      await runProcess({ executable, args, timeoutMs, spawnProcess });
      const file = await downloadedFile(directory);
      if (file.size > maxBytes) {
        throw new MediaDownloadError('file_too_large', `Видео больше лимита ${maxBytes} байт.`);
      }

      return {
        buffer: await readFile(file.path),
        filename: basename(file.path),
        size: file.size
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return {
    enabled,
    maxBytes,
    maxLinks,
    urlsFromMessage,
    downloadVideo
  };
};

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultTimeoutMs = 15_000;
const maxErrorLength = 4_000;

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class FrameExtractionError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'FrameExtractionError';
    this.code = code;
  }
}

const runFfmpeg = ({ executable, args, timeoutMs, spawnProcess }) =>
  new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    try {
      child = spawnProcess(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new FrameExtractionError('spawn_failed', 'Не удалось запустить ffmpeg.', error));
      return;
    }

    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-maxErrorLength);
    });

    child.once('error', (error) => {
      finish(() => reject(new FrameExtractionError('spawn_failed', 'Не удалось запустить ffmpeg.', error)));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new FrameExtractionError(
          'extract_failed',
          `ffmpeg завершился с кодом ${code ?? signal ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`
        ));
      });
    });

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new FrameExtractionError(
        'timeout',
        'ffmpeg превысил допустимое время извлечения кадра.'
      )));
    }, timeoutMs);
  });

export const createDemotivationFrameExtractor = ({
  env = process.env,
  spawnProcess = spawn
} = {}) => {
  const executable = env.FFMPEG_PATH || 'ffmpeg';
  const timeoutMs = positiveNumber(env.DEMOTIVATION_FRAME_TIMEOUT_MS, defaultTimeoutMs);

  const extractFirstFrame = async (videoBuffer) => {
    if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
      throw new TypeError('videoBuffer must be a non-empty Buffer');
    }

    const directory = await mkdtemp(join(tmpdir(), 'ayaubot-demotivation-'));
    const inputPath = join(directory, 'video-note.mp4');
    const outputPath = join(directory, 'first-frame.jpg');

    try {
      await writeFile(inputPath, videoBuffer);
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
      ];
      await runFfmpeg({ executable, args, timeoutMs, spawnProcess });

      try {
        return await readFile(outputPath);
      } catch (error) {
        throw new FrameExtractionError('missing_frame', 'ffmpeg не создал первый кадр.', error);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return { executable, timeoutMs, extractFirstFrame };
};

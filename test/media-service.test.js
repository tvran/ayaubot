import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MediaDownloadError,
  createMediaDownloadService,
  extractSupportedVideoUrls,
  isSupportedVideoUrl
} from '../src/media/service.js';

test('recognizes supported Reels and TikTok URLs only', () => {
  assert.equal(isSupportedVideoUrl('https://www.instagram.com/reel/ABC123/'), true);
  assert.equal(isSupportedVideoUrl('https://instagram.com/reels/ABC123/'), true);
  assert.equal(isSupportedVideoUrl('https://www.tiktok.com/@name/video/123'), true);
  assert.equal(isSupportedVideoUrl('https://vm.tiktok.com/ZM123/'), true);
  assert.equal(isSupportedVideoUrl('https://instagram.com/p/ABC123/'), false);
  assert.equal(isSupportedVideoUrl('https://evilinstagram.com/reel/ABC123/'), false);
  assert.equal(isSupportedVideoUrl('file:///tmp/video.mp4'), false);
});

test('extracts unique supported URLs and strips punctuation', () => {
  const instagram = 'https://www.instagram.com/reel/ABC123/?igsh=value';
  const tiktok = 'https://vm.tiktok.com/ZM123/';
  const text = `Первое: ${instagram}, дубль: ${instagram}. Второе: ${tiktok}!`;

  assert.deepEqual(extractSupportedVideoUrls(text), [instagram, tiktok]);
  assert.deepEqual(extractSupportedVideoUrls(text, 1), [instagram]);
});

test('downloads a file with yt-dlp arguments and returns its buffer', async () => {
  let invocation;
  const spawnProcess = (executable, args) => {
    invocation = { executable, args };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;

    queueMicrotask(async () => {
      const template = args[args.indexOf('--output') + 1];
      await writeFile(template.replace('%(ext)s', 'mp4'), Buffer.from('video'));
      child.emit('close', 0, null);
    });
    return child;
  };
  const service = createMediaDownloadService({
    env: { YT_DLP_PATH: '/opt/bin/yt-dlp', MEDIA_MAX_BYTES: '100' },
    spawnProcess
  });

  const result = await service.downloadVideo('https://www.instagram.com/reel/ABC123/');

  assert.equal(result.buffer.toString(), 'video');
  assert.equal(result.filename, 'video.mp4');
  assert.equal(invocation.executable, '/opt/bin/yt-dlp');
  assert.equal(invocation.args[invocation.args.indexOf('--format-sort') + 1], 'codec:h264');
  assert.equal(invocation.args.at(-2), '--');
  assert.equal(invocation.args.at(-1), 'https://www.instagram.com/reel/ABC123/');
});

test('rejects a downloaded file above the configured limit', async () => {
  const spawnProcess = (executable, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(async () => {
      const template = args[args.indexOf('--output') + 1];
      await writeFile(template.replace('%(ext)s', 'mp4'), Buffer.from('too large'));
      child.emit('close', 0, null);
    });
    return child;
  };
  const service = createMediaDownloadService({ env: { MEDIA_MAX_BYTES: '4' }, spawnProcess });

  await assert.rejects(
    service.downloadVideo('https://vm.tiktok.com/ZM123/'),
    (error) => error instanceof MediaDownloadError && error.code === 'file_too_large'
  );
});

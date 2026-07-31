import { EventEmitter } from 'node:events';
import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FrameExtractionError,
  createDemotivationFrameExtractor
} from '../src/demotivation/frame.js';

test('extracts the first video-note frame with ffmpeg and removes temporary files', async () => {
  let invocation;
  const spawnProcess = (executable, args) => {
    invocation = { executable, args };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;

    queueMicrotask(async () => {
      await writeFile(args.at(-1), Buffer.from('first-frame'));
      child.emit('close', 0, null);
    });
    return child;
  };
  const extractor = createDemotivationFrameExtractor({
    env: { FFMPEG_PATH: '/opt/bin/ffmpeg', DEMOTIVATION_FRAME_TIMEOUT_MS: '5000' },
    spawnProcess
  });

  const frame = await extractor.extractFirstFrame(Buffer.from('video-note'));

  assert.equal(frame.toString(), 'first-frame');
  assert.equal(invocation.executable, '/opt/bin/ffmpeg');
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf('-frames:v'), -1),
    ['-frames:v', '1', '-q:v', '2']
  );
  await assert.rejects(stat(dirname(invocation.args.at(-1))), { code: 'ENOENT' });
});

test('reports an ffmpeg failure without using a real media process', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('invalid video'));
      child.emit('close', 1, null);
    });
    return child;
  };
  const extractor = createDemotivationFrameExtractor({ spawnProcess });

  await assert.rejects(
    extractor.extractFirstFrame(Buffer.from('broken-video')),
    (error) => error instanceof FrameExtractionError
      && error.code === 'extract_failed'
      && error.message.includes('invalid video')
  );
});

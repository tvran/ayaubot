import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createIsolatedQuoteRenderer,
  QuoteRenderTimeoutError
} from '../src/render/isolated-quote.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killedWith = [];
    this.sent = [];
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.();
  }

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }
}

test('isolated quote renderer returns child result and terminates isolation process', async () => {
  const child = new FakeChild();
  const renderer = createIsolatedQuoteRenderer({
    env: { QUOTE_RENDER_TIMEOUT_MS: '1000' },
    forkImpl: () => child,
    entrypoint: '/fake/quote-child.js'
  });

  const pending = renderer.renderStickerWebp([{ message_id: 1, text: 'quote' }]);
  child.emit('message', { type: 'result', data: Buffer.from('webp').toString('base64') });

  assert.deepEqual(await pending, Buffer.from('webp'));
  assert.deepEqual(child.sent, [{
    type: 'renderStickerWebp',
    messages: [{ message_id: 1, text: 'quote' }]
  }]);
  assert.deepEqual(child.killedWith, ['SIGKILL']);
});

test('isolated quote renderer kills child when render timeout expires', async () => {
  const child = new FakeChild();
  const renderer = createIsolatedQuoteRenderer({
    env: { QUOTE_RENDER_TIMEOUT_MS: '20' },
    forkImpl: () => child,
    entrypoint: '/fake/quote-child.js'
  });

  await assert.rejects(
    renderer.renderStickerWebp([{ message_id: 1 }]),
    (error) => error instanceof QuoteRenderTimeoutError && error.code === 'quote_render_timeout'
  );
  assert.deepEqual(child.killedWith, ['SIGKILL']);
});

test('isolated quote renderer kills child immediately on job cancellation', async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const renderer = createIsolatedQuoteRenderer({
    env: { QUOTE_RENDER_TIMEOUT_MS: '1000' },
    forkImpl: () => child,
    entrypoint: '/fake/quote-child.js'
  });
  const reason = new Error('job cancelled');

  const pending = renderer.renderStickerWebp([{ message_id: 1 }], {
    signal: controller.signal
  });
  controller.abort(reason);

  await assert.rejects(pending, reason);
  assert.deepEqual(child.killedWith, ['SIGKILL']);
});

test('isolated quote renderer rejects an already aborted request without forking', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  let forks = 0;
  const renderer = createIsolatedQuoteRenderer({
    forkImpl: () => {
      forks += 1;
      return new FakeChild();
    }
  });

  await assert.rejects(
    renderer.renderStickerWebp([], { signal: controller.signal }),
    /already cancelled/
  );
  assert.equal(forks, 0);
});

test('real isolated child renders a simple WebP without external services', async () => {
  const renderer = createIsolatedQuoteRenderer({
    env: {
      ...process.env,
      BOT_TOKEN: '',
      QUOTE_RENDER_TIMEOUT_MS: '10000',
      EMOJI_CDN_TIMEOUT_MS: '500'
    }
  });

  const result = await renderer.renderStickerWebp([{
    message_id: 1,
    date: 1,
    from: { first_name: 'Isolation' },
    text: 'Render probe'
  }]);

  assert.equal(result.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.subarray(8, 12).toString(), 'WEBP');
});

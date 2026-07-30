import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createWebhookRequestHandler } from '../src/server/http.js';

const request = (body) => {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST';
  stream.url = '/telegram/webhook';
  stream.headers = { 'x-telegram-bot-api-secret-token': 'test-secret' };
  return stream;
};

const response = () => ({
  status: null,
  body: '',
  writeHead(status) { this.status = status; },
  end(body = '') { this.body = String(body); }
});

test('webhook server persists before ACK and keeps internal errors at HTTP 200', async () => {
  const updates = [];
  let shouldFail = false;
  const handler = createWebhookRequestHandler({
    ingress: {
      async enqueue(update) {
        if (shouldFail) throw new Error('database unavailable');
        updates.push(update);
      }
    },
    queue: {
      async ping() {},
      async stats() { return { byStatus: {}, oldestPendingAgeSeconds: 0 }; }
    },
    env: { WEBHOOK_SECRET: 'test-secret' },
    logger: { error() {} }
  });

  const first = response();
  await handler(request({ update_id: 1 }), first);
  assert.equal(first.status, 200);
  assert.deepEqual(updates, [{ update_id: 1 }]);

  shouldFail = true;
  const failed = response();
  await handler(request({ update_id: 2 }), failed);
  assert.equal(failed.status, 200);
  assert.deepEqual(JSON.parse(failed.body), { ok: true });
});

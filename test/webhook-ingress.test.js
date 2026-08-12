import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebhookIngress } from '../src/webhook/ingress.js';

const telegramUpdate = {
  update_id: 42,
  message: {
    message_id: 9,
    chat: { id: -10042 },
    from: { id: 7 },
    text: '/help'
  }
};

test('enqueues a Telegram update and reports duplicate delivery safely', async () => {
  const records = [];
  const queue = {
    async enqueue(record) {
      records.push(record);
      return { inserted: records.length === 1, updateId: record.updateId };
    }
  };
  const ingress = createWebhookIngress({ queue, logger: { log() {} } });

  assert.deepEqual(await ingress.enqueue(telegramUpdate), {
    accepted: true,
    duplicate: false,
    lane: 'default'
  });
  assert.deepEqual(await ingress.enqueue(telegramUpdate), {
    accepted: true,
    duplicate: true,
    lane: 'default'
  });
  assert.equal(records[0].updateId, 42);
  assert.equal(records[0].chatId, -10042);
});

test('ignores unsupported Telegram update types without queue access', async () => {
  const ingress = createWebhookIngress({
    queue: { enqueue() { throw new Error('must not be called'); } },
    logger: { log() {} }
  });
  assert.deepEqual(await ingress.enqueue({ update_id: 1, inline_query: {} }), {
    accepted: false,
    ignored: true
  });
});

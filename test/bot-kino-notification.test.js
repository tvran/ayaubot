import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotApp } from '../src/bot/app.js';

test('cinema notifications do not mention or look up chat members', async () => {
  const requests = [];
  let knownUsersCalls = 0;
  const bot = createBotApp({
    env: { BOT_TOKEN: '123:test' },
    analytics: {
      async knownUsers() {
        knownUsersCalls += 1;
        return [{ user_id: 7, first_name: 'Tagged user' }];
      }
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return { status: 200, json: async () => ({ ok: true, result: {} }) };
    },
    logger: { log() {}, error() {} }
  });

  await bot.notifyCinemaAvailability({ chatId: '-100', text: 'Свободные места' });

  assert.equal(knownUsersCalls, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/sendMessage$/u);
  assert.deepEqual(requests[0].payload, {
    chat_id: '-100',
    text: 'Свободные места',
    disable_web_page_preview: true
  });
  assert.equal('entities' in requests[0].payload, false);
});

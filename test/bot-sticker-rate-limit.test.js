import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotApp } from '../src/bot/app.js';
import { createRateLimiter } from '../src/bot/rate-limit.js';

const update = (id, text = '/qs', date = 1_000) => ({
  update_id: id,
  message: {
    message_id: id,
    date,
    chat: { id: -100, type: 'supergroup' },
    from: { id: 7 },
    text,
    reply_to_message: { from: { id: 123 }, sticker: { file_id: 'quote', file_unique_id: 'unique-quote' } }
  }
});

const fakeBot = ({ handler, ...options } = {}) => {
  const calls = [];
  const errors = [];
  const bot = createBotApp({
    ...options,
    env: { BOT_TOKEN: '123:test', STICKER_SET_NAME: 'quotes_by_TestBot', STICKER_SET_OWNER_ID: '5', ...options.env },
    logger: { log() {}, error(...args) { errors.push(args); } },
    fetchImpl: async (url, init) => {
      const method = url.split('/').at(-1);
      const payload = JSON.parse(init.body);
      calls.push({ method, payload });
      const data = await handler?.(method, payload) || { ok: true, result: true };
      return { status: data.error_code || 200, json: async () => data };
    }
  });
  return { bot, calls, errors };
};

test('/qs reports the actual new pack and repeated saving returns its link without adding again', async () => {
  let created = false;
  const { bot, calls, errors } = fakeBot({ handler: async (method, payload) => {
    if (method === 'getStickerSet') {
      if (payload.name === 'quotes_by_TestBot') {
        return { ok: true, result: { stickers: Array.from({ length: 120 }, (_, i) => ({ file_id: `old-${i}` })) } };
      }
      if (!created) return { ok: false, error_code: 400, description: 'STICKERSET_INVALID' };
      return { ok: true, result: { stickers: [{ file_id: 'quote', file_unique_id: 'unique-quote' }] } };
    }
    if (method === 'createNewStickerSet') created = true;
  } });
  await bot.handleUpdate(update(1));
  await bot.handleUpdate(update(2));
  const responses = calls.filter((item) => item.method === 'sendMessage');
  assert.equal(responses.length, 2);
  assert.match(responses[0].payload.text, /https:\/\/t.me\/addstickers\/quotes_2_by_TestBot/);
  assert.match(responses[1].payload.text, /уже сохранён/);
  assert.equal(calls.filter((item) => item.method === 'createNewStickerSet').length, 1);
  assert.equal(calls.some((item) => item.method === 'addStickerToSet'), false);
  assert.equal(errors.length, 0);
});

test('/qs handles failures creating the pack and gives a useful reply instead of failing the queue job', async () => {
  const { bot, calls, errors } = fakeBot({ handler: async (method) => {
    if (method === 'getStickerSet') return { ok: false, error_code: 400, description: 'STICKERSET_INVALID' };
    if (method === 'createNewStickerSet') return { ok: false, error_code: 400, description: 'USER_ID_INVALID' };
  } });
  await bot.handleUpdate(update(1));
  assert.match(calls.find((item) => item.method === 'sendMessage').payload.text, /владельца набора/);
  assert.equal(errors.length, 1);
});

test('temporary Telegram network failures propagate to the worker and a later retry can save', async () => {
  let offline = true;
  const { bot, calls } = fakeBot({ handler: async (method) => {
    if (method === 'getStickerSet') {
      if (offline) throw new Error('fetch failed');
      return { ok: true, result: { stickers: [] } };
    }
  } });
  await assert.rejects(bot.handleUpdate(update(1)), /fetch failed/);
  assert.equal(calls.some((item) => item.method === 'sendMessage'), false);
  offline = false;
  await bot.handleUpdate(update(1));
  assert.equal(calls.filter((item) => item.method === 'addStickerToSet').length, 1);
});

test('retry after a failed confirmation does not add the already saved sticker twice', async () => {
  const stickers = [];
  let failConfirmation = true;
  const { bot, calls } = fakeBot({ handler: async (method) => {
    if (method === 'getStickerSet') return { ok: true, result: { stickers: [...stickers] } };
    if (method === 'addStickerToSet') stickers.push({ file_id: 'quote', file_unique_id: 'unique-quote' });
    if (method === 'sendMessage' && failConfirmation) {
      failConfirmation = false;
      throw new Error('confirmation failed');
    }
  } });
  await assert.rejects(bot.handleUpdate(update(1)), /confirmation failed/);
  await bot.handleUpdate(update(1));
  assert.equal(calls.filter((item) => item.method === 'addStickerToSet').length, 1);
  assert.equal(stickers.length, 1);
  assert.match(calls.at(-1).payload.text, /уже сохранён/);
});

test('mixed commands, stickers and summaries share the burst limit before early handlers run', async () => {
  let current = 1_000_000;
  let anecdotes = 0;
  let summaries = 0;
  const texts = ['/qs', '/anecdote', '#итогидня', '/help', '/qs', '/anecdote', '/help', '#итогидня', '/help'];
  const { bot, calls } = fakeBot({
    rateLimiter: createRateLimiter({ env: {}, now: () => current }),
    analytics: {},
    anecdote: { async text() { anecdotes += 1; return 'Анекдот'; } },
    dailySummary: { async summaryText() { summaries += 1; return 'Итоги'; } },
    handler: async (method) => {
      if (method === 'getStickerSet') return { ok: true, result: { stickers: [{ file_id: 'quote' }] } };
    }
  });
  for (let i = 0; i < texts.length; i += 1) {
    await bot.handleUpdate(update(i + 1, texts[i], 1_000 + Math.floor(i / 2)));
    current += 4_000;
  }
  await bot.handleUpdate(update(10, '/anecdote', 1_004));
  await bot.handleUpdate(update(11, '/qs', 1_004));
  assert.equal(anecdotes, 2);
  assert.equal(summaries, 2);
  assert.equal(calls.filter((item) => item.method === 'sendMessage' && /Подожди 60 сек/.test(item.payload.text)).length, 1);
  assert.equal(calls.filter((item) => item.method === 'getStickerSet').length, 2);
  current += 60_000;
  await bot.handleUpdate(update(12, '/anecdote', 1_100));
  assert.equal(anecdotes, 3);
});

test('ordinary chat messages do not spend the command burst budget', async () => {
  let ingested = 0;
  const { bot, calls } = fakeBot({
    rateLimiter: createRateLimiter({ env: {}, now: () => 1_000_000 }),
    analytics: { async ingestMessage() { ingested += 1; }, async checkCodewordGuess() {} }
  });
  for (let i = 0; i < 20; i += 1) await bot.handleUpdate(update(i, 'Обычный разговор'));
  await bot.handleUpdate(update(21, '/help'));
  assert.equal(ingested, 20);
  assert.equal(calls.filter((item) => item.method === 'sendMessage').length, 1);
  assert.doesNotMatch(calls.at(-1).payload.text, /Слишком часто/);
});

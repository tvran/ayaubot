import assert from 'node:assert/strict';
import test from 'node:test';
import { createPercentGameService, loadPercentGameConfig } from '../src/games/percent.js';

const config = loadPercentGameConfig();

const createFakeRedis = () => {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options = {}) {
      writes.push({ key, value, options });
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }
  };
};

const message = {
  from: { id: 10, first_name: 'Аяу', username: 'ayau' }
};

test('keeps one result per user and parameter for the configured TTL', async () => {
  const redis = createFakeRedis();
  const randomValues = [0.45, 0, 0.99, 0.99];
  const service = createPercentGameService({
    redis,
    config,
    random: () => randomValues.shift()
  });

  const first = await service.playText(message, 'gay');
  const second = await service.playText(message, 'gay');

  assert.equal(first, '@ayau гей на 45%.');
  assert.equal(second, first);
  assert.equal(randomValues.length, 2);
  assert.equal(redis.writes.length, 1);
  assert.deepEqual(redis.writes[0].options, { ex: 86400, nx: true });
});

test('uses the replied-to user and resolves parameter aliases', async () => {
  const redis = createFakeRedis();
  const service = createPercentGameService({ redis, config, random: () => 0 });
  const replyMessage = {
    ...message,
    reply_to_message: {
      from: { id: 20, first_name: 'Мира', last_name: 'Тест' }
    }
  };

  const text = await service.playText(replyMessage, 'гей');

  assert.equal(text, 'Мира Тест гей на 0%.');
  assert.match(redis.writes[0].key, /:20:gay$/);
});

test('stores independent results for each user and parameter', async () => {
  const redis = createFakeRedis();
  const randomValues = [0.1, 0, 0.9, 0];
  const service = createPercentGameService({
    redis,
    config,
    random: () => randomValues.shift()
  });

  const gay = await service.playText(message, 'gay');
  const toxic = await service.playText(message, 'toxic');

  assert.match(gay, /10%/);
  assert.match(toxic, /90%/);
  assert.equal(redis.values.size, 2);
});

test('shows usage, available parameters, and Redis requirement', async () => {
  const service = createPercentGameService({ config });

  assert.match(await service.playText(message, ''), /\/percent <параметр>/);
  assert.match(await service.playText(message, 'unknown'), /gay, toxic, dead_inside, alcoholic, genius/);
  assert.match(await service.playText(message, 'gay'), /нужен Redis/);
});

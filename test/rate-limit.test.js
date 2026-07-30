import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/bot/rate-limit.js';

test('limits heavy work independently per user and resets the window', () => {
  let current = 1_000;
  const limiter = createRateLimiter({
    env: {
      RATE_LIMIT_WINDOW_MS: '1000',
      RATE_LIMIT_COMMANDS: '3',
      RATE_LIMIT_HEAVY: '2'
    },
    now: () => current
  });
  const request = { chatId: -1, userId: 10, kind: 'heavy' };

  assert.equal(limiter.consume(request).allowed, true);
  assert.equal(limiter.consume(request).allowed, true);
  assert.deepEqual(limiter.consume(request), { allowed: false, retryAfterSeconds: 1 });
  assert.equal(limiter.consume({ ...request, userId: 11 }).allowed, true);

  current += 1001;
  assert.equal(limiter.consume(request).allowed, true);
});

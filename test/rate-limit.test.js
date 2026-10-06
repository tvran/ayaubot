import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/bot/rate-limit.js';

test('the tenth request in five seconds starts a fixed one-minute cooldown across kinds', () => {
  let current = 1_000;
  const limiter = createRateLimiter({ env: {}, now: () => current });
  const request = { chatId: -1, userId: 10, kind: 'heavy' };
  for (let i = 0; i < 9; i += 1) {
    current += 500;
    assert.equal(limiter.consume({ ...request, kind: i % 2 ? 'command' : 'heavy' }).allowed, true);
  }
  const blockedAt = current;
  assert.deepEqual(limiter.consume(request), { allowed: false, retryAfterSeconds: 60, notify: true });
  assert.equal(limiter.consume({ ...request, userId: 11 }).allowed, true);
  assert.equal(limiter.consume({ ...request, chatId: -2 }).allowed, true);
  current += 59_001;
  limiter.prune();
  assert.deepEqual(limiter.consume(request), { allowed: false, retryAfterSeconds: 1, notify: false });
  current = blockedAt + 60_000;
  assert.equal(limiter.consume(request).allowed, true);
});

test('regular requests spread over more than five seconds never trigger a minute cooldown', () => {
  let current = 0;
  const limiter = createRateLimiter({ env: {}, now: () => current });
  for (let i = 0; i < 100; i += 1) {
    current += 600;
    assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'heavy' }).allowed, true);
  }
});

test('the sliding window includes the five-second boundary but expires older requests', () => {
  for (const elapsed of [5_000, 5_001]) {
    let current = 0;
    const limiter = createRateLimiter({ env: {}, now: () => current });
    for (let i = 0; i < 9; i += 1) {
      assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'command' }).allowed, true);
    }
    current = elapsed;
    assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'command' }).allowed, elapsed > 5_000);
  }
});

test('queue delays preserve the sent-time burst and retries do not count as new requests', () => {
  let current = 100_000;
  const limiter = createRateLimiter({ env: {}, now: () => current });
  for (let i = 0; i < 9; i += 1) {
    const request = { chatId: 1, userId: 2, kind: 'heavy', requestId: i, requestedAt: 1_000 + i * 400 };
    assert.equal(limiter.consume(request).allowed, true);
    assert.equal(limiter.consume(request).allowed, true);
    current += 90_000;
    limiter.prune();
  }
  assert.deepEqual(limiter.consume({ chatId: 1, userId: 2, kind: 'heavy', requestId: 9, requestedAt: 4_600 }), {
    allowed: false, retryAfterSeconds: 60, notify: true
  });
});

test('configuration uses burst settings and ignores the previous low heavy limit', () => {
  let current = 0;
  const limiter = createRateLimiter({
    env: { RATE_LIMIT_HEAVY: '2', RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_BURST_REQUESTS: '4', RATE_LIMIT_BURST_WINDOW_MS: '1000', RATE_LIMIT_COOLDOWN_MS: '2000' },
    now: () => current
  });
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'heavy' }).allowed, true);
  assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'heavy' }).retryAfterSeconds, 2);
  current = 2_000;
  limiter.prune();
  assert.equal(limiter.consume({ chatId: 1, userId: 2, kind: 'heavy' }).allowed, true);
});

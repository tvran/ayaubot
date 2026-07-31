import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisCircuit } from '../src/redis/client.js';

test('opens the Redis circuit after a failure and probes again after cooldown', async () => {
  let current = 0;
  let calls = 0;
  const circuit = createRedisCircuit({
    redis: {},
    env: { REDIS_CIRCUIT_OPEN_MS: '1000' },
    now: () => current,
    logger: { error() {} }
  });

  assert.equal(await circuit.call('cache', async () => {
    calls += 1;
    throw new Error('timeout');
  }, 'fallback'), 'fallback');
  assert.equal(circuit.isOpen(), true);

  assert.equal(await circuit.call('cache', async () => {
    calls += 1;
    return 'unexpected';
  }, 'fallback'), 'fallback');
  assert.equal(calls, 1);

  current += 1001;
  assert.equal(await circuit.call('cache', async () => {
    calls += 1;
    return 'ok';
  }, 'fallback'), 'ok');
  assert.equal(calls, 2);
  assert.equal(circuit.isOpen(), false);
});

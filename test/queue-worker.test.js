import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateWorker } from '../src/queue/worker.js';

const workerEnv = {
  WORKER_CONCURRENCY: '1',
  WORKER_HEAVY_CONCURRENCY: '1',
  WORKER_JOB_TIMEOUT_MS: '20',
  WORKER_HEAVY_JOB_TIMEOUT_MS: '20',
  QUEUE_POLL_MS: '1',
  QUEUE_MAX_ATTEMPTS: '1',
  QUEUE_RETRY_BASE_MS: '1',
  QUEUE_RETRY_MAX_MS: '1'
};

const job = {
  update_id: 5,
  chat_id: -100,
  lane: 'default',
  attempts: 1,
  payload: { update_id: 5, message: { chat: { id: -100 } } },
  locked_by: 'test:default:0'
};

test('completes a claimed update once', async () => {
  let claimed = false;
  let completed;
  let resolveCompleted;
  const done = new Promise((resolve) => { resolveCompleted = resolve; });
  const queue = {
    lockMs: 60_000,
    async claim({ lane }) {
      if (lane !== 'default' || claimed) return null;
      claimed = true;
      return job;
    },
    async heartbeat() {},
    async complete(value, durationMs) {
      completed = { value, durationMs };
      resolveCompleted();
    },
    async fail() {
      throw new Error('unexpected failure');
    }
  };
  const handled = [];
  const worker = createUpdateWorker({
    queue,
    env: workerEnv,
    workerId: 'test',
    logger: { log() {}, error() {} },
    handleUpdate: async (value) => handled.push(value.update_id)
  });

  worker.start();
  await done;
  await worker.stop();

  assert.deepEqual(handled, [5]);
  assert.equal(completed.value.update_id, 5);
  assert.ok(completed.durationMs >= 0);
});

test('moves a timed out update to dead-letter after the last attempt', async () => {
  let claimed = false;
  let failed;
  let resolveFailed;
  const done = new Promise((resolve) => { resolveFailed = resolve; });
  const queue = {
    lockMs: 60_000,
    async claim({ lane }) {
      if (lane !== 'default' || claimed) return null;
      claimed = true;
      return job;
    },
    async heartbeat() {},
    async complete() {
      throw new Error('unexpected completion');
    },
    async fail(value, details) {
      failed = { value, details };
      resolveFailed();
    }
  };
  const worker = createUpdateWorker({
    queue,
    env: workerEnv,
    workerId: 'test',
    logger: { log() {}, error() {} },
    handleUpdate: async (value, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });

  worker.start();
  await done;
  await worker.stop();

  assert.equal(failed.value.update_id, 5);
  assert.equal(failed.details.dead, true);
  assert.equal(failed.details.error.code, 'job_timeout');
});

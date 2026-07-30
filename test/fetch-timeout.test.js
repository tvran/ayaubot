import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithTimeout, RequestTimeoutError } from '../src/runtime/fetch.js';

test('aborts a fetch when its deadline expires', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await assert.rejects(
    fetchWithTimeout(fetchImpl, 'https://example.test', {}, {
      timeoutMs: 5,
      label: 'test request'
    }),
    (error) => error instanceof RequestTimeoutError && error.code === 'timeout'
  );
});

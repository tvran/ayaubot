export class RequestTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
    this.code = 'timeout';
  }
}

const linkedController = (parentSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    unlink: () => parentSignal?.removeEventListener('abort', abort)
  };
};

export const fetchWithTimeout = async (
  fetchImpl,
  url,
  options = {},
  { timeoutMs, signal, label = 'request' }
) => {
  const linked = linkedController(signal);
  const timeoutError = new RequestTimeoutError(label, timeoutMs);
  const timer = setTimeout(() => linked.controller.abort(timeoutError), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: linked.controller.signal });
  } catch (error) {
    if (linked.controller.signal.aborted && !signal?.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    linked.unlink();
  }
};

export const waitWithSignal = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error('Aborted'));
    return;
  }
  const finish = (callback) => {
    signal?.removeEventListener('abort', abort);
    callback();
  };
  const timer = setTimeout(() => finish(resolve), delayMs);
  const abort = () => {
    clearTimeout(timer);
    finish(() => reject(signal.reason || new Error('Aborted')));
  };
  signal?.addEventListener('abort', abort, { once: true });
});

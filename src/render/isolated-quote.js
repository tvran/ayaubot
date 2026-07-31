import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childEntrypoint = fileURLToPath(new URL('./quote-child.js', import.meta.url));

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export class QuoteRenderTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`quote render timed out after ${timeoutMs}ms`);
    this.name = 'QuoteRenderTimeoutError';
    this.code = 'quote_render_timeout';
  }
}

const abortError = (signal) => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('quote render aborted');
  error.name = 'AbortError';
  error.code = 'aborted';
  return error;
};

const childError = (payload = {}) => {
  const error = new Error(payload.message || 'quote render child failed');
  error.name = payload.name || 'QuoteRenderError';
  error.code = payload.code || 'quote_render_failed';
  return error;
};

export const createIsolatedQuoteRenderer = ({
  env = process.env,
  forkImpl = fork,
  entrypoint = childEntrypoint
} = {}) => {
  const timeoutMs = Math.max(10, positiveInteger(env.QUOTE_RENDER_TIMEOUT_MS, 30_000));

  const renderStickerWebp = (messages, { signal } = {}) => {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise((resolve, reject) => {
      const child = forkImpl(entrypoint, [], {
        env,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced'
      });
      let settled = false;
      let timer;

      const terminate = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may already have exited.
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        terminate();
        callback();
      };
      const fail = (error) => finish(() => reject(error));
      const onAbort = () => fail(abortError(signal));
      const onMessage = (message) => {
        if (message?.type === 'result' && typeof message.data === 'string') {
          finish(() => resolve(Buffer.from(message.data, 'base64')));
          return;
        }
        if (message?.type === 'error') fail(childError(message.error));
      };
      const onError = (error) => fail(error);
      const onExit = (code, exitSignal) => {
        const error = new Error(`quote render child exited before returning a result (code=${code}, signal=${exitSignal || 'none'})`);
        error.code = 'quote_render_child_exit';
        fail(error);
      };

      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(new QuoteRenderTimeoutError(timeoutMs)), timeoutMs);

      child.send({ type: 'renderStickerWebp', messages }, (error) => {
        if (error) fail(error);
      });
    });
  };

  return { renderStickerWebp, timeoutMs };
};

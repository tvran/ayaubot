import { randomUUID } from 'node:crypto';

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const retryDelayMs = ({ attempt, baseMs, maxMs, random }) => {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.round(exponential * (0.8 + random() * 0.4));
};

const errorText = (error) => error?.stack || error?.message || String(error);

export const createUpdateWorker = ({
  queue,
  handleUpdate,
  metrics,
  env = process.env,
  logger = console,
  random = Math.random,
  workerId = `${process.env.RAILWAY_REPLICA_ID || process.pid}:${randomUUID()}`
} = {}) => {
  if (!queue) throw new Error('Update worker requires a PostgreSQL queue.');
  if (typeof handleUpdate !== 'function') throw new Error('Update worker requires handleUpdate.');

  const concurrency = {
    default: asPositiveInteger(env.WORKER_CONCURRENCY, 4),
    heavy: asPositiveInteger(env.WORKER_HEAVY_CONCURRENCY, 1)
  };
  const pollMs = asPositiveInteger(env.QUEUE_POLL_MS, 1_000);
  const maxAttempts = asPositiveInteger(env.QUEUE_MAX_ATTEMPTS, 5);
  const retryBaseMs = asPositiveInteger(env.QUEUE_RETRY_BASE_MS, 1_000);
  const retryMaxMs = asPositiveInteger(env.QUEUE_RETRY_MAX_MS, 60_000);
  const timeoutMs = {
    default: asPositiveInteger(env.WORKER_JOB_TIMEOUT_MS, 120_000),
    heavy: asPositiveInteger(env.WORKER_HEAVY_JOB_TIMEOUT_MS, 180_000)
  };
  const heartbeatMs = Math.max(1_000, Math.floor(queue.lockMs / 3));
  const loops = [];
  let stopping = false;
  let active = 0;
  let lastPollAt = null;

  const processJob = async (job) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    let rejectTimeout;
    const timeout = new Promise((resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      const error = new Error(`job timed out after ${timeoutMs[job.lane]}ms`);
      error.code = 'job_timeout';
      controller.abort(error);
      rejectTimeout(error);
    }, timeoutMs[job.lane]);
    const heartbeat = setInterval(() => {
      queue.heartbeat(job).catch((error) => logger.error('queue heartbeat failed', {
        updateId: String(job.update_id),
        error: errorText(error)
      }));
    }, heartbeatMs);
    heartbeat.unref?.();
    active += 1;

    try {
      await Promise.race([
        handleUpdate(job.payload, { signal: controller.signal, lane: job.lane }),
        timeout
      ]);
      const durationMs = Date.now() - startedAt;
      await queue.complete(job, durationMs);
      metrics?.increment('worker_jobs_total', { lane: job.lane, result: 'completed' });
      metrics?.observe('worker_job_duration_seconds', durationMs / 1000, { lane: job.lane });
      logger.log('queue job completed', {
        updateId: String(job.update_id),
        chatId: String(job.chat_id),
        lane: job.lane,
        attempts: job.attempts,
        durationMs
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const dead = Number(job.attempts) >= maxAttempts;
      const delayMs = retryDelayMs({
        attempt: Number(job.attempts),
        baseMs: retryBaseMs,
        maxMs: retryMaxMs,
        random
      });
      await queue.fail(job, { dead, error, delayMs, durationMs });
      metrics?.increment('worker_jobs_total', { lane: job.lane, result: dead ? 'dead' : 'retry' });
      metrics?.observe('worker_job_duration_seconds', durationMs / 1000, { lane: job.lane });
      logger.error('queue job failed', {
        updateId: String(job.update_id),
        chatId: String(job.chat_id),
        lane: job.lane,
        attempts: job.attempts,
        dead,
        retryDelayMs: dead ? null : delayMs,
        durationMs,
        error: errorText(error)
      });
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      active -= 1;
    }
  };

  const runLoop = async (lane, index) => {
    const loopWorkerId = `${workerId}:${lane}:${index}`;
    while (!stopping) {
      try {
        lastPollAt = new Date();
        const job = await queue.claim({ lane, workerId: loopWorkerId });
        if (!job) {
          await wait(pollMs);
          continue;
        }
        await processJob(job);
      } catch (error) {
        metrics?.increment('worker_loop_errors_total', { lane });
        logger.error('queue worker loop failed', { lane, error: errorText(error) });
        await wait(Math.max(1_000, pollMs));
      }
    }
  };

  const start = () => {
    for (const lane of ['default', 'heavy']) {
      for (let index = 0; index < concurrency[lane]; index += 1) {
        loops.push(runLoop(lane, index));
      }
    }
    logger.log('queue worker started', { workerId, concurrency, maxAttempts });
  };

  const stop = async () => {
    stopping = true;
    await Promise.allSettled(loops);
  };

  const health = () => ({
    ok: !stopping,
    workerId,
    active,
    concurrency,
    lastPollAt: lastPollAt?.toISOString() || null
  });

  return { start, stop, health, retryDelayMs };
};

import { Redis } from '@upstash/redis';

const asNonNegativeInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const createRedisClient = (env = process.env) => {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const timeoutMs = asPositiveInteger(env.REDIS_TIMEOUT_MS, 1_000);
  const retries = asNonNegativeInteger(env.REDIS_RETRIES, 0);
  return new Redis({
    url,
    token,
    retry: retries ? { retries } : false,
    signal: () => AbortSignal.timeout(timeoutMs)
  });
};

export const createRedisCircuit = ({
  redis,
  metrics,
  logger = console,
  env = process.env,
  now = () => Date.now()
} = {}) => {
  if (!redis) return null;
  const openMs = asPositiveInteger(env.REDIS_CIRCUIT_OPEN_MS, 30_000);
  let openUntil = 0;
  let loggedOpen = false;

  const call = async (operation, callback, fallback) => {
    if (openUntil > now()) {
      metrics?.increment('redis_operations_total', { operation, result: 'circuit_open' });
      return fallback;
    }
    const startedAt = now();
    try {
      const result = await callback(redis);
      openUntil = 0;
      loggedOpen = false;
      metrics?.increment('redis_operations_total', { operation, result: 'ok' });
      metrics?.observe('redis_operation_duration_seconds', (now() - startedAt) / 1000, { operation });
      return result;
    } catch (error) {
      openUntil = now() + openMs;
      metrics?.increment('redis_operations_total', { operation, result: 'error' });
      metrics?.observe('redis_operation_duration_seconds', (now() - startedAt) / 1000, { operation });
      if (!loggedOpen) {
        loggedOpen = true;
        logger.error('redis circuit opened', {
          operation,
          openMs,
          error: error?.message || String(error)
        });
      }
      return fallback;
    }
  };

  return { raw: redis, call, isOpen: () => openUntil > now() };
};

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const createRateLimiter = ({ env = process.env, now = () => Date.now() } = {}) => {
  const windowMs = asPositiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000);
  const limits = {
    command: asPositiveInteger(env.RATE_LIMIT_COMMANDS, 10),
    heavy: asPositiveInteger(env.RATE_LIMIT_HEAVY, 2)
  };
  const buckets = new Map();

  const consume = ({ chatId, userId, kind }) => {
    if (!limits[kind] || !chatId || !userId) return { allowed: true, retryAfterSeconds: 0 };
    const current = now();
    const key = `${chatId}:${userId}:${kind}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= limits[kind]) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))
    };
  };

  const prune = () => {
    const current = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= current) buckets.delete(key);
  };

  return { consume, prune, limits, windowMs };
};

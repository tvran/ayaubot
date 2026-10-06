const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const createRateLimiter = ({ env = process.env, now = () => Date.now() } = {}) => {
  const windowMs = asPositiveInteger(env.RATE_LIMIT_BURST_WINDOW_MS, 5_000);
  const threshold = asPositiveInteger(env.RATE_LIMIT_BURST_REQUESTS, 10);
  const cooldownMs = asPositiveInteger(env.RATE_LIMIT_COOLDOWN_MS, 60_000);
  // Keep sent-time history across a long heavy job (default timeout: 180 seconds).
  const retentionMs = Math.max(windowMs, cooldownMs, 5 * 60_000);
  const buckets = new Map();
  const allowed = () => ({ allowed: true, retryAfterSeconds: 0 });

  const consume = ({ chatId, userId, kind, requestId, requestedAt }) => {
    if (!['command', 'heavy'].includes(kind) || !chatId || !userId) return allowed();
    const current = now();
    const key = `${chatId}:${userId}`;
    let bucket = buckets.get(key);
    if (!bucket || (bucket.blockedUntil && bucket.blockedUntil <= current)) {
      bucket = { events: [], seen: new Map(), latestAt: -Infinity, blockedUntil: 0 };
      buckets.set(key, bucket);
    }
    bucket.lastUsedAt = current;
    if (bucket.blockedUntil > current) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - current) / 1000)),
        notify: false
      };
    }

    for (const [id, seenAt] of bucket.seen) {
      if (seenAt + retentionMs <= current) bucket.seen.delete(id);
    }
    const id = requestId == null ? null : String(requestId);
    if (id !== null && bucket.seen.has(id)) return allowed();
    if (id !== null) bucket.seen.set(id, current);

    // Telegram timestamps preserve a burst even when rendering delays queue processing.
    const sentAt = Number.isFinite(requestedAt) ? Math.min(requestedAt, current) : current;
    bucket.latestAt = Math.max(bucket.latestAt, sentAt);
    bucket.events = bucket.events.filter((at) => at >= bucket.latestAt - windowMs);
    if (sentAt >= bucket.latestAt - windowMs) bucket.events.push(sentAt);
    if (bucket.events.length < threshold) return allowed();

    bucket.blockedUntil = current + cooldownMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(cooldownMs / 1000),
      notify: true
    };
  };

  const prune = () => {
    const current = now();
    for (const [key, bucket] of buckets) {
      if (bucket.blockedUntil <= current && bucket.lastUsedAt + retentionMs <= current) {
        buckets.delete(key);
      }
    }
  };

  return { consume, prune, threshold, windowMs, cooldownMs };
};

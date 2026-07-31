import { randomUUID } from 'node:crypto';

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const createPostgresSchedulerLease = ({
  pool,
  env = process.env,
  ownerId = `${process.env.RAILWAY_REPLICA_ID || process.pid}:${randomUUID()}`,
  logger = console
} = {}) => {
  if (!pool) return null;
  const ttlMs = asPositiveInteger(env.SCHEDULER_LEASE_MS, 10 * 60 * 1000);
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

  const acquire = async (name) => {
    const result = await pool.query(
      `
      insert into scheduler_leases (name, owner_id, locked_until, updated_at)
      values ($1, $2, now() + ($3::int * interval '1 second'), now())
      on conflict (name) do update set
        owner_id = excluded.owner_id,
        locked_until = excluded.locked_until,
        updated_at = now()
      where scheduler_leases.locked_until <= now()
         or scheduler_leases.owner_id = excluded.owner_id
      returning name
      `,
      [name, ownerId, ttlSeconds]
    );
    return result.rowCount > 0;
  };

  const renew = (name) => pool.query(
    `
    update scheduler_leases
    set locked_until = now() + ($3::int * interval '1 second'), updated_at = now()
    where name = $1 and owner_id = $2
    `,
    [name, ownerId, ttlSeconds]
  );

  const release = (name) => pool.query(
    'delete from scheduler_leases where name = $1 and owner_id = $2',
    [name, ownerId]
  );

  const run = async (name, task) => {
    if (!await acquire(name)) return { acquired: false };
    const timer = setInterval(() => {
      renew(name).catch((error) => logger.error('scheduler lease renewal failed', {
        name,
        error: error?.message || String(error)
      }));
    }, Math.max(1_000, Math.floor(ttlMs / 3)));
    timer.unref?.();
    try {
      return { acquired: true, result: await task() };
    } finally {
      clearInterval(timer);
      await release(name);
    }
  };

  return { ownerId, ttlMs, run };
};

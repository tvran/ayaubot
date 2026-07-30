const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const maxErrorLength = 4_000;

export const createPostgresUpdateQueue = ({ pool, env = process.env } = {}) => {
  if (!pool) return null;

  const enqueueTimeoutMs = asPositiveInteger(env.WEBHOOK_ENQUEUE_TIMEOUT_MS, 1_500);
  const lockMs = asPositiveInteger(env.QUEUE_LOCK_MS, 60_000);
  const lockSeconds = Math.max(1, Math.ceil(lockMs / 1000));

  const enqueue = async ({ updateId, chatId, lane, payload }) => {
    const result = await pool.query({
      text: `
        insert into telegram_update_jobs (update_id, chat_id, lane, payload)
        values ($1, $2, $3, $4::jsonb)
        on conflict (update_id) do nothing
        returning update_id
      `,
      values: [updateId, chatId, lane, JSON.stringify(payload)],
      query_timeout: enqueueTimeoutMs
    });
    return { inserted: result.rowCount > 0, updateId };
  };

  const claim = async ({ lane, workerId }) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const candidates = await client.query(
        `
        select j.*
        from telegram_update_jobs j
        where j.lane = $1
          and j.status in ('pending', 'retry')
          and j.available_at <= now()
          and not exists (
            select 1
            from telegram_update_jobs older
            where older.chat_id = j.chat_id
              and older.update_id < j.update_id
              and older.status in ('pending', 'retry', 'processing')
          )
        order by j.update_id
        for update skip locked
        limit 20
        `,
        [lane]
      );

      for (const candidate of candidates.rows) {
        const lock = await client.query(
          `
          insert into telegram_chat_job_locks (chat_id, update_id, worker_id, locked_until)
          values ($1, $2, $3, now() + ($4::int * interval '1 second'))
          on conflict (chat_id) do update set
            update_id = excluded.update_id,
            worker_id = excluded.worker_id,
            locked_until = excluded.locked_until
          where telegram_chat_job_locks.locked_until <= now()
          returning chat_id
          `,
          [candidate.chat_id, candidate.update_id, workerId, lockSeconds]
        );
        if (!lock.rowCount) continue;

        const claimed = await client.query(
          `
          update telegram_update_jobs
          set status = 'processing',
            attempts = attempts + 1,
            started_at = now(),
            finished_at = null,
            locked_by = $2
          where update_id = $1
          returning *
          `,
          [candidate.update_id, workerId]
        );
        await client.query('commit');
        return claimed.rows[0] || null;
      }

      await client.query('commit');
      return null;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  const heartbeat = async (job) => {
    const result = await pool.query(
      `
      update telegram_chat_job_locks
      set locked_until = now() + ($4::int * interval '1 second')
      where chat_id = $1 and update_id = $2 and worker_id = $3
      `,
      [job.chat_id, job.update_id, job.locked_by, lockSeconds]
    );
    if (result.rowCount) {
      await pool.query(
        `update telegram_update_jobs set started_at = now() where update_id = $1 and status = 'processing'`,
        [job.update_id]
      );
    }
    return result.rowCount > 0;
  };

  const finish = async ({ job, status, error, delayMs = 0, durationMs }) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `
        update telegram_update_jobs
        set status = $2,
          available_at = case when $2 = 'retry'
            then now() + ($3::int * interval '1 millisecond')
            else available_at
          end,
          finished_at = case when $2 in ('completed', 'dead') then now() else null end,
          locked_by = null,
          last_error = $4,
          duration_ms = $5,
          payload = case when $2 = 'completed' then '{}'::jsonb else payload end
        where update_id = $1 and status = 'processing'
        `,
        [
          job.update_id,
          status,
          Math.max(0, Math.round(delayMs)),
          error ? String(error).slice(0, maxErrorLength) : null,
          Math.max(0, Math.round(durationMs || 0))
        ]
      );
      await client.query(
        `
        delete from telegram_chat_job_locks
        where chat_id = $1 and update_id = $2 and worker_id = $3
        `,
        [job.chat_id, job.update_id, job.locked_by]
      );
      await client.query('commit');
    } catch (finishError) {
      await client.query('rollback');
      throw finishError;
    } finally {
      client.release();
    }
  };

  const complete = (job, durationMs) => finish({ job, status: 'completed', durationMs });

  const fail = (job, { dead, error, delayMs, durationMs }) => finish({
    job,
    status: dead ? 'dead' : 'retry',
    error: error?.stack || error?.message || String(error),
    delayMs,
    durationMs
  });

  const stats = async () => {
    const [counts, oldest] = await Promise.all([
      pool.query(`select lane, status, count(*)::int as count from telegram_update_jobs group by lane, status`),
      pool.query(`
        select extract(epoch from (now() - min(received_at)))::int as age_seconds
        from telegram_update_jobs
        where status in ('pending', 'retry', 'processing')
      `)
    ]);
    const byStatus = {};
    for (const lane of ['default', 'heavy']) {
      for (const status of ['pending', 'retry', 'processing', 'completed', 'dead']) {
        byStatus[`${lane}:${status}`] = 0;
      }
    }
    for (const row of counts.rows) byStatus[`${row.lane}:${row.status}`] = row.count;
    return {
      byStatus,
      oldestPendingAgeSeconds: oldest.rows[0]?.age_seconds || 0
    };
  };

  const cleanup = async ({ completedDays = 7, deadDays = 30 } = {}) => {
    const result = await pool.query(
      `
      delete from telegram_update_jobs
      where (status = 'completed' and finished_at < now() - ($1::int * interval '1 day'))
         or (status = 'dead' and finished_at < now() - ($2::int * interval '1 day'))
      `,
      [completedDays, deadDays]
    );
    return result.rowCount;
  };

  const recoverStale = async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from telegram_chat_job_locks where locked_until <= now()');
      const result = await client.query(
        `
        update telegram_update_jobs
        set status = 'retry',
          available_at = now(),
          locked_by = null,
          started_at = null,
          last_error = coalesce(last_error, 'worker lease expired')
        where status = 'processing'
          and started_at < now() - ($1::int * interval '1 second')
        `,
        [lockSeconds]
      );
      await client.query('commit');
      return result.rowCount;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  const ping = async () => {
    await pool.query({
      text: 'select 1 from telegram_update_jobs limit 1',
      query_timeout: enqueueTimeoutMs
    });
    return true;
  };

  return {
    lockMs,
    enqueue,
    claim,
    heartbeat,
    complete,
    fail,
    stats,
    cleanup,
    recoverStale,
    ping
  };
};

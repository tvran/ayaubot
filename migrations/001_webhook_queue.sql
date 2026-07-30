create table if not exists telegram_update_jobs (
  update_id bigint primary key,
  chat_id bigint not null,
  lane text not null check (lane in ('default', 'heavy')),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'retry', 'processing', 'completed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_by text,
  last_error text,
  duration_ms integer
);

create index if not exists telegram_update_jobs_ready_idx
on telegram_update_jobs (lane, available_at, update_id)
where status in ('pending', 'retry');

create index if not exists telegram_update_jobs_chat_order_idx
on telegram_update_jobs (chat_id, update_id)
where status in ('pending', 'retry', 'processing');

create index if not exists telegram_update_jobs_status_received_idx
on telegram_update_jobs (status, received_at);

create table if not exists telegram_chat_job_locks (
  chat_id bigint primary key,
  update_id bigint not null,
  worker_id text not null,
  locked_until timestamptz not null
);

create index if not exists telegram_chat_job_locks_expiry_idx
on telegram_chat_job_locks (locked_until);

create table if not exists scheduler_leases (
  name text primary key,
  owner_id text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);


create table if not exists ticketon_daily_digests (
  chat_id bigint not null,
  digest_date date not null,
  processed_at timestamptz not null default now(),
  primary key (chat_id, digest_date)
);

create index if not exists ticketon_daily_digests_processed_at_idx
on ticketon_daily_digests (processed_at);

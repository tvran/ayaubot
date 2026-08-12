create table if not exists ticketon_chat_preferences (
  chat_id bigint primary key,
  earliest_session_minute smallint not null default 0,
  updated_by bigint,
  updated_at timestamptz not null default now(),
  check (earliest_session_minute between 0 and 1439)
);

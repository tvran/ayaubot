alter table court_sessions add column round integer not null default 1;
alter table court_sessions drop constraint court_sessions_chat_id_day_key;
create unique index court_sessions_chat_day_round_idx on court_sessions (chat_id, day, round);

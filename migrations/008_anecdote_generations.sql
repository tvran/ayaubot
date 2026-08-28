create table anecdote_generations (
  chat_id bigint not null,
  day date not null,
  count integer not null default 0 check (count >= 0),
  primary key (chat_id, day)
);

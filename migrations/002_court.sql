create table court_sessions (
  id bigserial primary key,
  chat_id bigint not null,
  day date not null,
  question text not null,
  message_id bigint,
  status text not null default 'open' check (status in ('open', 'closed')),
  closes_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (chat_id, day)
);

create table court_options (
  session_id bigint not null references court_sessions(id) on delete cascade,
  user_id bigint not null,
  label text not null,
  votes integer not null default 0,
  primary key (session_id, user_id)
);

create table court_votes (
  session_id bigint not null references court_sessions(id) on delete cascade,
  voter_id bigint not null,
  option_user_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (session_id, voter_id)
);

create table court_question_banks (
  id boolean primary key default true check (id),
  questions jsonb not null,
  updated_at timestamptz not null default now()
);

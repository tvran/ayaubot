create table ticketon_watched_movies (
  chat_id bigint not null,
  movie_id bigint not null,
  movie_name text not null,
  movie_slug text not null,
  created_by bigint,
  created_at timestamptz not null default now(),
  primary key (chat_id, movie_id)
);

create table ticketon_watched_cinemas (
  chat_id bigint not null,
  cinema_id bigint not null,
  cinema_name text not null,
  created_by bigint,
  created_at timestamptz not null default now(),
  primary key (chat_id, cinema_id)
);

create table ticketon_notifications (
  chat_id bigint not null,
  session_id bigint not null,
  movie_id bigint not null,
  cinema_id bigint not null,
  notified_at timestamptz not null default now(),
  primary key (chat_id, session_id)
);

create index ticketon_watched_movies_movie_idx
on ticketon_watched_movies (movie_id);

create index ticketon_notifications_notified_at_idx
on ticketon_notifications (notified_at);

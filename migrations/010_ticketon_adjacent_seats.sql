alter table ticketon_chat_preferences
add column if not exists adjacent_seats smallint not null default 2
check (adjacent_seats between 1 and 6);

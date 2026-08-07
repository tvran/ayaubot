alter table court_sessions add column command_message_id bigint;
create unique index court_sessions_chat_command_message_idx on court_sessions (chat_id, command_message_id) where command_message_id is not null;

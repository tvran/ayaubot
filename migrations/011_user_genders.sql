alter table users
add column if not exists gender text check (gender in ('он', 'она'));

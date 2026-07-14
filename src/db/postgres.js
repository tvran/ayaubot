const schema = `
create table if not exists users (
  chat_id bigint not null,
  user_id bigint not null,
  first_name text,
  last_name text,
  username text,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists word_counts (
  chat_id bigint not null,
  user_id bigint not null,
  word text not null,
  day date not null,
  count integer not null default 0,
  primary key (chat_id, user_id, word, day)
);

create index if not exists word_counts_chat_day_word_idx
on word_counts (chat_id, day, word);

create index if not exists word_counts_chat_day_user_idx
on word_counts (chat_id, day, user_id);

create table if not exists codeword_games (
  id bigserial primary key,
  chat_id bigint not null,
  word text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  guessed_at timestamptz,
  guessed_by_user_id bigint,
  guessed_message_id bigint,
  status text not null
);

create index if not exists codeword_games_active_idx
on codeword_games (chat_id, status);

create table if not exists daily_picks (
  chat_id bigint not null,
  kind text not null,
  day date not null,
  user_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, kind, day)
);
`;

const dayString = (date) => date.toISOString().slice(0, 10);

export const createPostgresDb = async (env = process.env) => {
  if (!env.DATABASE_URL) return null;

  let Pool;
  try {
    ({ Pool } = await import('pg'));
  } catch (error) {
    throw new Error('DATABASE_URL is configured but pg is not installed. Add the pg dependency before enabling Postgres analytics.');
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(env.PG_POOL_SIZE || 5)
  });

  await pool.query(schema);

  const query = (text, params) => pool.query(text, params);

  return {
    pool,

    async upsertUser(chatId, user) {
      await query(
        `
        insert into users (chat_id, user_id, first_name, last_name, username, updated_at)
        values ($1, $2, $3, $4, $5, now())
        on conflict (chat_id, user_id) do update set
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          username = excluded.username,
          updated_at = now()
        `,
        [chatId, user.id, user.first_name || null, user.last_name || null, user.username || null]
      );
    },

    async incrementWordCounts({ chatId, userId, date, counts }) {
      const entries = Array.from(counts.entries());
      if (!entries.length) return;

      const values = [];
      const placeholders = entries.map(([word, count], index) => {
        const base = index * 5;
        values.push(chatId, userId, word, dayString(date), count);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });

      await query(
        `
        insert into word_counts (chat_id, user_id, word, day, count)
        values ${placeholders.join(', ')}
        on conflict (chat_id, user_id, word, day) do update set
          count = word_counts.count + excluded.count
        `,
        values
      );
    },

    async topWords(chatId, days, limit) {
      const result = await query(
        `
        select word, sum(count)::int as total
        from word_counts
        where chat_id = $1
          and day >= current_date - ($2::int * interval '1 day')
        group by word
        order by total desc
        limit $3
        `,
        [chatId, days, limit]
      );
      return result.rows;
    },

    async topUsersForWords(chatId, words, days) {
      if (!words.length) return new Map();
      const result = await query(
        `
        select distinct on (wc.word)
          wc.word,
          wc.user_id,
          sum(wc.count)::int as total,
          u.first_name,
          u.last_name,
          u.username
        from word_counts wc
        left join users u on u.chat_id = wc.chat_id and u.user_id = wc.user_id
        where wc.chat_id = $1
          and wc.word = any($2)
          and wc.day >= current_date - ($3::int * interval '1 day')
        group by wc.word, wc.user_id, u.first_name, u.last_name, u.username
        order by wc.word, total desc
        `,
        [chatId, words, days]
      );
      return new Map(result.rows.map((row) => [row.word, row]));
    },

    async activeCodeword(chatId) {
      const result = await query(
        `
        select *
        from codeword_games
        where chat_id = $1 and status = 'active'
        order by started_at desc
        limit 1
        `,
        [chatId]
      );
      return result.rows[0] || null;
    },

    async createCodeword(chatId, word) {
      const result = await query(
        `
        insert into codeword_games (chat_id, word, expires_at, status)
        values ($1, $2, now() + interval '3 days', 'active')
        returning *
        `,
        [chatId, word]
      );
      return result.rows[0];
    },

    async expireCodeword(id) {
      await query(
        "update codeword_games set status = 'expired' where id = $1 and status = 'active'",
        [id]
      );
    },

    async guessCodeword(id, userId, messageId) {
      await query(
        `
        update codeword_games
        set status = 'guessed',
          guessed_at = now(),
          guessed_by_user_id = $2,
          guessed_message_id = $3
        where id = $1 and status = 'active'
        `,
        [id, userId, messageId]
      );
    },

    async codewordWinners(chatId, limit = 10) {
      const result = await query(
        `
        select
          cw.guessed_by_user_id as user_id,
          count(*)::int as wins,
          u.first_name,
          u.last_name,
          u.username
        from codeword_games cw
        left join users u on u.chat_id = cw.chat_id and u.user_id = cw.guessed_by_user_id
        where cw.chat_id = $1
          and cw.status = 'guessed'
          and cw.guessed_by_user_id is not null
        group by cw.guessed_by_user_id, u.first_name, u.last_name, u.username
        order by wins desc, max(cw.guessed_at) desc
        limit $2
        `,
        [chatId, limit]
      );
      return result.rows;
    },

    async dailyPick(chatId, kind, excludedUserIds = []) {
      const today = dayString(new Date());
      const current = await query(
        `
        select
          dp.user_id,
          u.first_name,
          u.last_name,
          u.username
        from daily_picks dp
        left join users u on u.chat_id = dp.chat_id and u.user_id = dp.user_id
        where dp.chat_id = $1 and dp.kind = $2 and dp.day = $3
        `,
        [chatId, kind, today]
      );
      if (current.rows[0]) return current.rows[0];

      const candidate = await query(
        `
        select user_id, first_name, last_name, username
        from users
        where chat_id = $1
          and not (user_id = any($2::bigint[]))
        order by random()
        limit 1
        `,
        [chatId, excludedUserIds]
      );
      if (!candidate.rows[0]) return null;

      const user = candidate.rows[0];
      await query(
        `
        insert into daily_picks (chat_id, kind, day, user_id)
        values ($1, $2, $3, $4)
        on conflict (chat_id, kind, day) do nothing
        `,
        [chatId, kind, today, user.user_id]
      );

      return user;
    },

    async resetDailyPick(chatId, kind) {
      await query(
        `
        delete from daily_picks
        where chat_id = $1 and kind = $2 and day = $3
        `,
        [chatId, kind, dayString(new Date())]
      );
    },

    async dailyPickHistory(chatId, kind, limit = 10) {
      const result = await query(
        `
        select
          dp.day,
          dp.user_id,
          u.first_name,
          u.last_name,
          u.username
        from daily_picks dp
        left join users u on u.chat_id = dp.chat_id and u.user_id = dp.user_id
        where dp.chat_id = $1 and dp.kind = $2
        order by dp.day desc
        limit $3
        `,
        [chatId, kind, limit]
      );
      return result.rows;
    }
  };
};

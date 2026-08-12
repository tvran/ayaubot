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

create table if not exists message_counts (
  chat_id bigint not null,
  user_id bigint not null,
  count integer not null default 0,
  primary key (chat_id, user_id)
);

create table if not exists chat_messages (
  chat_id bigint not null,
  message_id bigint not null,
  user_id bigint,
  text text not null,
  sent_at timestamptz not null,
  primary key (chat_id, message_id)
);

create index if not exists chat_messages_chat_sent_at_idx
on chat_messages (chat_id, sent_at);

create table if not exists daily_summaries (
  chat_id bigint not null,
  day date not null,
  text text not null,
  format_version integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (chat_id, day)
);

alter table daily_summaries
add column if not exists format_version integer not null default 1;

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

create table if not exists birthdays (
  chat_id bigint not null,
  user_id bigint not null,
  chat_title text,
  first_name text,
  last_name text,
  username text,
  birth_day smallint not null check (birth_day between 1 and 31),
  birth_month smallint not null check (birth_month between 1 and 12),
  birth_year smallint check (birth_year is null or birth_year between 1900 and 9999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create index if not exists birthdays_month_day_idx
on birthdays (birth_month, birth_day);

create table if not exists birthday_notifications (
  chat_id bigint not null,
  birthday_user_id bigint not null,
  recipient_user_id bigint not null,
  event_date date not null,
  kind text not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, birthday_user_id, recipient_user_id, event_date, kind)
);
`;

const dayString = (date) => date.toISOString().slice(0, 10);

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

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
    max: positiveInteger(env.PG_POOL_SIZE, 5),
    connectionTimeoutMillis: positiveInteger(env.PG_CONNECT_TIMEOUT_MS, 5_000),
    idleTimeoutMillis: positiveInteger(env.PG_IDLE_TIMEOUT_MS, 30_000),
    statement_timeout: positiveInteger(env.PG_STATEMENT_TIMEOUT_MS, 15_000),
    query_timeout: positiveInteger(env.PG_QUERY_TIMEOUT_MS, 20_000)
  });

  await pool.query(schema);

  const query = (text, params) => pool.query(text, params);

  return {
    pool,

    async close() {
      await pool.end();
    },

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

    async incrementMessageCount(chatId, userId) {
      await query(
        `
        insert into message_counts (chat_id, user_id, count)
        values ($1, $2, 1)
        on conflict (chat_id, user_id) do update set
          count = message_counts.count + 1
        `,
        [chatId, userId]
      );
    },

    async storeChatMessage(message) {
      const text = String(message.text || message.caption || '').trim();
      if (!text || !message.chat?.id || !message.message_id) return;
      await query(
        `
        insert into chat_messages (chat_id, message_id, user_id, text, sent_at)
        values ($1, $2, $3, $4, to_timestamp($5))
        on conflict (chat_id, message_id) do update set
          user_id = excluded.user_id,
          text = excluded.text,
          sent_at = excluded.sent_at
        `,
        [message.chat.id, message.message_id, message.from?.id || null, text, message.date || Math.floor(Date.now() / 1000)]
      );
    },

    async messagesForDay(chatId, day) {
      const result = await query(
        `
        select message_id, user_id, text
        from chat_messages
        where chat_id = $1
          and (sent_at at time zone 'Asia/Almaty')::date = $2::date
        order by message_id
        `,
        [chatId, day]
      );
      return result.rows;
    },

    async usersForChat(chatId) {
      const result = await query(
        `
        select user_id, first_name, last_name, username
        from users
        where chat_id = $1
        order by updated_at desc, user_id
        `,
        [chatId]
      );
      return result.rows;
    },

    async dailySummary(chatId, day, formatVersion = 1) {
      const result = await query(
        'select text from daily_summaries where chat_id = $1 and day = $2::date and format_version = $3',
        [chatId, day, formatVersion]
      );
      return result.rows[0]?.text || null;
    },

    async saveDailySummary(chatId, day, text, formatVersion = 1) {
      await query(
        `
        insert into daily_summaries (chat_id, day, text, format_version)
        values ($1, $2::date, $3, $4)
        on conflict (chat_id, day) do update set
          text = excluded.text,
          format_version = excluded.format_version,
          created_at = now()
        `,
        [chatId, day, text, formatVersion]
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

    async topMessageSenders(chatId, limit = 10) {
      const result = await query(
        `
        select
          mc.user_id,
          mc.count,
          u.first_name,
          u.last_name,
          u.username
        from message_counts mc
        left join users u on u.chat_id = mc.chat_id and u.user_id = mc.user_id
        where mc.chat_id = $1
        order by mc.count desc
        limit $2
        `,
        [chatId, limit]
      );
      return result.rows;
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
    },

    async upsertBirthday({ chatId, chatTitle, user, day, month, year }) {
      await query(
        `
        insert into birthdays (
          chat_id, user_id, chat_title, first_name, last_name, username,
          birth_day, birth_month, birth_year, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
        on conflict (chat_id, user_id) do update set
          chat_title = excluded.chat_title,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          username = excluded.username,
          birth_day = excluded.birth_day,
          birth_month = excluded.birth_month,
          birth_year = excluded.birth_year,
          updated_at = now()
        `,
        [
          chatId,
          user.id,
          chatTitle,
          user.first_name || null,
          user.last_name || null,
          user.username || null,
          day,
          month,
          year
        ]
      );
    },

    async removeBirthday(chatId, userId) {
      if (!userId) return false;
      const result = await query(
        'delete from birthdays where chat_id = $1 and user_id = $2',
        [chatId, userId]
      );
      return result.rowCount > 0;
    },

    async listBirthdays(chatId) {
      const result = await query(
        `
        select *
        from birthdays
        where chat_id = $1
        order by birth_month, birth_day, first_name, user_id
        `,
        [chatId]
      );
      return result.rows;
    },

    async birthdaysForDate({ month, day, includeLeapDay = false }) {
      const result = await query(
        `
        select *
        from birthdays
        where (birth_month = $1 and birth_day = $2)
          or ($3::boolean and birth_month = 2 and birth_day = 29)
        order by chat_id, user_id
        `,
        [month, day, includeLeapDay]
      );
      return result.rows;
    },

    async birthdayReminderRecipients(chatId, excludedUserId) {
      const result = await query(
        `
        select user_id, first_name, last_name, username
        from birthdays
        where chat_id = $1 and user_id <> $2
        order by user_id
        `,
        [chatId, excludedUserId]
      );
      return result.rows;
    },

    async claimBirthdayNotification({
      chatId,
      birthdayUserId,
      recipientUserId,
      eventDate,
      kind
    }) {
      const result = await query(
        `
        insert into birthday_notifications (
          chat_id, birthday_user_id, recipient_user_id, event_date, kind
        )
        values ($1, $2, $3, $4, $5)
        on conflict do nothing
        returning 1
        `,
        [chatId, birthdayUserId, recipientUserId, eventDate, kind]
      );
      return result.rowCount > 0;
    },

    async releaseBirthdayNotification({
      chatId,
      birthdayUserId,
      recipientUserId,
      eventDate,
      kind
    }) {
      await query(
        `
        delete from birthday_notifications
        where chat_id = $1
          and birthday_user_id = $2
          and recipient_user_id = $3
          and event_date = $4
          and kind = $5
        `,
        [chatId, birthdayUserId, recipientUserId, eventDate, kind]
      );
    },

    async deleteBirthdayNotificationsBefore(date) {
      await query('delete from birthday_notifications where event_date < $1', [date]);
    },

    async listKinoMovieWatches(chatId) {
      const params = [];
      const where = chatId === undefined ? '' : 'where chat_id = $1';
      if (chatId !== undefined) params.push(chatId);
      const result = await query(
        `
        select chat_id, movie_id, movie_name, created_by, created_at
        from kino_watched_movies
        ${where}
        order by chat_id, movie_name, movie_id
        `,
        params
      );
      return result.rows;
    },

    async listKinoCinemaWatches(chatId) {
      const params = [];
      const where = chatId === undefined ? '' : 'where chat_id = $1';
      if (chatId !== undefined) params.push(chatId);
      const result = await query(
        `
        select chat_id, cinema_id, cinema_name, created_by, created_at
        from kino_watched_cinemas
        ${where}
        order by chat_id, cinema_name, cinema_id
        `,
        params
      );
      return result.rows;
    },

    async toggleKinoMovieWatch({ chatId, movieId, movieName, userId }) {
      const removed = await query(
        'delete from kino_watched_movies where chat_id = $1 and movie_id = $2',
        [chatId, movieId]
      );
      if (removed.rowCount > 0) return false;
      const inserted = await query(
        `
        insert into kino_watched_movies (chat_id, movie_id, movie_name, created_by)
        values ($1, $2, $3, $4)
        on conflict (chat_id, movie_id) do nothing
        returning 1
        `,
        [chatId, movieId, movieName, userId || null]
      );
      return inserted.rowCount > 0;
    },

    async toggleKinoCinemaWatch({ chatId, cinemaId, cinemaName, userId }) {
      const removed = await query(
        'delete from kino_watched_cinemas where chat_id = $1 and cinema_id = $2',
        [chatId, cinemaId]
      );
      if (removed.rowCount > 0) return false;
      const inserted = await query(
        `
        insert into kino_watched_cinemas (chat_id, cinema_id, cinema_name, created_by)
        values ($1, $2, $3, $4)
        on conflict (chat_id, cinema_id) do nothing
        returning 1
        `,
        [chatId, cinemaId, cinemaName, userId || null]
      );
      return inserted.rowCount > 0;
    },

    async claimKinoNotification({ chatId, sessionId, movieId, cinemaId }) {
      const result = await query(
        `
        insert into kino_notifications (chat_id, session_id, movie_id, cinema_id)
        values ($1, $2, $3, $4)
        on conflict do nothing
        returning 1
        `,
        [chatId, sessionId, movieId, cinemaId]
      );
      return result.rowCount > 0;
    },

    async releaseKinoNotification({ chatId, sessionId }) {
      await query(
        'delete from kino_notifications where chat_id = $1 and session_id = $2',
        [chatId, sessionId]
      );
    },

    async deleteKinoNotificationsBefore(date) {
      await query('delete from kino_notifications where notified_at < $1::date', [date]);
    },

    async listTicketonMovieWatches(chatId) {
      const params = [];
      const where = chatId === undefined ? '' : 'where chat_id = $1';
      if (chatId !== undefined) params.push(chatId);
      const result = await query(
        `
        select chat_id, movie_id, movie_name, movie_slug, created_by, created_at
        from ticketon_watched_movies
        ${where}
        order by chat_id, movie_name, movie_id
        `,
        params
      );
      return result.rows;
    },

    async listTicketonCinemaWatches(chatId) {
      const params = [];
      const where = chatId === undefined ? '' : 'where chat_id = $1';
      if (chatId !== undefined) params.push(chatId);
      const result = await query(
        `
        select chat_id, cinema_id, cinema_name, created_by, created_at
        from ticketon_watched_cinemas
        ${where}
        order by chat_id, cinema_name, cinema_id
        `,
        params
      );
      return result.rows;
    },

    async toggleTicketonMovieWatch({ chatId, movieId, movieName, movieSlug, userId }) {
      const removed = await query(
        'delete from ticketon_watched_movies where chat_id = $1 and movie_id = $2',
        [chatId, movieId]
      );
      if (removed.rowCount > 0) return false;
      const inserted = await query(
        `
        insert into ticketon_watched_movies (
          chat_id, movie_id, movie_name, movie_slug, created_by
        )
        values ($1, $2, $3, $4, $5)
        on conflict (chat_id, movie_id) do nothing
        returning 1
        `,
        [chatId, movieId, movieName, movieSlug, userId || null]
      );
      return inserted.rowCount > 0;
    },

    async toggleTicketonCinemaWatch({ chatId, cinemaId, cinemaName, userId }) {
      const removed = await query(
        'delete from ticketon_watched_cinemas where chat_id = $1 and cinema_id = $2',
        [chatId, cinemaId]
      );
      if (removed.rowCount > 0) return false;
      const inserted = await query(
        `
        insert into ticketon_watched_cinemas (chat_id, cinema_id, cinema_name, created_by)
        values ($1, $2, $3, $4)
        on conflict (chat_id, cinema_id) do nothing
        returning 1
        `,
        [chatId, cinemaId, cinemaName, userId || null]
      );
      return inserted.rowCount > 0;
    },

    async getTicketonChatPreferences(chatId) {
      const result = await query(
        `
        select chat_id, earliest_session_minute, updated_by, updated_at
        from ticketon_chat_preferences
        where chat_id = $1
        `,
        [chatId]
      );
      return result.rows[0] || null;
    },

    async setTicketonEarliestSessionTime({ chatId, earliestSessionMinute, userId }) {
      const result = await query(
        `
        insert into ticketon_chat_preferences (
          chat_id, earliest_session_minute, updated_by, updated_at
        )
        values ($1, $2, $3, now())
        on conflict (chat_id) do update
        set earliest_session_minute = excluded.earliest_session_minute,
            updated_by = excluded.updated_by,
            updated_at = now()
        returning chat_id, earliest_session_minute, updated_by, updated_at
        `,
        [chatId, earliestSessionMinute, userId || null]
      );
      return result.rows[0];
    },

    async claimTicketonNotification({ chatId, sessionId, movieId, cinemaId }) {
      const result = await query(
        `
        insert into ticketon_notifications (chat_id, session_id, movie_id, cinema_id)
        values ($1, $2, $3, $4)
        on conflict do nothing
        returning 1
        `,
        [chatId, sessionId, movieId, cinemaId]
      );
      return result.rowCount > 0;
    },

    async releaseTicketonNotification({ chatId, sessionId }) {
      await query(
        'delete from ticketon_notifications where chat_id = $1 and session_id = $2',
        [chatId, sessionId]
      );
    },

    async deleteTicketonNotificationsBefore(date) {
      await query('delete from ticketon_notifications where notified_at < $1::date', [date]);
    },

    async claimTicketonDailyDigest({ chatId, digestDate }) {
      const result = await query(
        `
        insert into ticketon_daily_digests (chat_id, digest_date)
        values ($1, $2::date)
        on conflict do nothing
        returning 1
        `,
        [chatId, digestDate]
      );
      return result.rowCount > 0;
    },

    async releaseTicketonDailyDigest({ chatId, digestDate }) {
      await query(
        'delete from ticketon_daily_digests where chat_id = $1 and digest_date = $2::date',
        [chatId, digestDate]
      );
    },

    async deleteTicketonDailyDigestsBefore(date) {
      await query('delete from ticketon_daily_digests where digest_date < $1::date', [date]);
    }
  };
};

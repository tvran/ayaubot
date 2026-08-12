import { findAdjacentSeatBlock } from './seats.js';

const defaultIntervalMs = 60 * 60 * 1000;
const defaultLookaheadDays = 7;
const defaultPageSize = 8;

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const itemName = (item, fallback) => String(item?.name || fallback).trim();

const shortLabel = (value, limit = 56) => {
  const symbols = Array.from(String(value));
  return symbols.length <= limit ? symbols.join('') : `${symbols.slice(0, limit - 1).join('')}…`;
};

const watchedSummary = (rows, field, emptyText, limit = 12) => {
  if (!rows.length) return [`• ${emptyText}`];
  const lines = rows.slice(0, limit).map((item) => `• ${shortLabel(item[field], 80)}`);
  if (rows.length > limit) lines.push(`• …и ещё ${rows.length - limit}`);
  return lines;
};

const pageNumber = (value, pages) => Math.min(
  Math.max(Number.parseInt(value, 10) || 0, 0),
  Math.max(pages - 1, 0)
);

const groupRowsByChat = (rows) => {
  const result = new Map();
  for (const row of rows || []) {
    const key = String(row.chat_id);
    const values = result.get(key) || [];
    values.push(row);
    result.set(key, values);
  }
  return result;
};

const localTimeParts = (instant, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(instant)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
};

const sessionPresentation = (session, timeZone) => {
  const instant = new Date(session.startTime);
  if (!Number.isFinite(instant.getTime())) return { date: session.date, time: '??:??' };
  const parts = localTimeParts(instant, timeZone);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
};

const findBlock = (seatPlan, requiredSeats) => {
  for (const section of seatPlan?.sections || []) {
    const block = findAdjacentSeatBlock(section.hallPlan, requiredSeats);
    if (block) return { ...block, sectionId: section.id, sectionName: section.name };
  }
  return null;
};

const alertText = ({ movie, cinema, hall, session, block, url, timeZone }) => {
  const starts = sessionPresentation(session, timeZone);
  const section = block.sectionName && block.sectionName !== 'Основной'
    ? `, сектор ${block.sectionName}`
    : '';
  return [
    '🎟 На наблюдаемый фильм появились хорошие места!',
    '',
    `🎬 ${movie.name}`,
    `🏢 ${cinema.name}${hall?.name ? `, ${hall.name}` : ''}${section}`,
    `🕒 ${starts.date} в ${starts.time}`,
    `💺 Ряд ${block.row}, места ${block.places.join(', ')} — рядом и не ниже середины зала.`,
    '',
    url,
    '',
    'Зову всех, пока лучшие места не растащили:\n'
  ].join('\n');
};

export const createTicketonCinemaMonitorService = ({
  db,
  client,
  env = process.env,
  now = () => new Date(),
  logger = console
} = {}) => {
  if (!client) throw new Error('Cinema monitor requires a Ticketon client.');

  const intervalMs = Math.max(positiveInteger(env.TICKETON_CHECK_INTERVAL_MS, defaultIntervalMs), 60_000);
  const lookaheadDays = Math.min(positiveInteger(env.TICKETON_LOOKAHEAD_DAYS, defaultLookaheadDays), 31);
  const adjacentSeats = Math.min(positiveInteger(env.TICKETON_ADJACENT_SEATS, 2), 12);
  const pageSize = Math.min(positiveInteger(env.TICKETON_MENU_PAGE_SIZE, defaultPageSize), 20);
  const maxSessionsPerRun = positiveInteger(env.TICKETON_MAX_SESSIONS_PER_RUN, 300);
  const catalogTtlMs = Math.max(positiveInteger(env.TICKETON_CATALOG_TTL_MS, 5 * 60 * 1000), 30_000);
  const catalogCache = new Map();

  const cached = async (key, loader) => {
    const current = catalogCache.get(key);
    if (current && current.expiresAt > Date.now()) return current.value;
    const value = await loader();
    catalogCache.set(key, { value, expiresAt: Date.now() + catalogTtlMs });
    return value;
  };

  const movieCatalog = () => cached('movies', async () => {
    const movies = await client.listMovies({ days: lookaheadDays });
    const unique = new Map();
    for (const movie of movies) {
      if (!Number.isInteger(Number(movie.id)) || !movie.slug) continue;
      unique.set(String(movie.id), {
        id: String(movie.id),
        name: itemName(movie, `Фильм ${movie.id}`),
        slug: String(movie.slug)
      });
    }
    return Array.from(unique.values()).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  });

  const cinemaCatalog = () => cached('cinemas', async () => {
    const cinemas = await client.listCinemas();
    const unique = new Map();
    for (const cinema of cinemas) {
      if (!Number.isInteger(Number(cinema.id))) continue;
      unique.set(String(cinema.id), {
        id: String(cinema.id),
        name: itemName(cinema, `Кинотеатр ${cinema.id}`)
      });
    }
    return Array.from(unique.values()).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  });

  const rootMenu = async (chatId) => {
    if (!db) {
      return {
        text: 'Монитор кино требует PostgreSQL: без него список наблюдения негде хранить.',
        reply_markup: { inline_keyboard: [] }
      };
    }
    const [movies, cinemas] = await Promise.all([
      db.listTicketonMovieWatches(chatId),
      db.listTicketonCinemaWatches(chatId)
    ]);
    const movieLines = watchedSummary(movies, 'movie_name', 'пока пусто');
    const cinemaLines = watchedSummary(cinemas, 'cinema_name', 'все кинотеатры');
    return {
      text: [
        '🎟 Монитор Ticketon — только кино в Астане',
        '',
        'Наблюдаемые фильмы:',
        ...movieLines,
        '',
        'Фильтр кинотеатров:',
        ...cinemaLines
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎬 Фильмы (${movies.length})`, callback_data: 'kino:movies:0' }],
          [{ text: `🏢 Кинотеатры (${cinemas.length || 'все'})`, callback_data: 'kino:cinemas:0' }],
          [{ text: '🔄 Обновить', callback_data: 'kino:root' }]
        ]
      }
    };
  };

  const listMenu = async (chatId, kind, requestedPage = 0) => {
    if (!db) return rootMenu(chatId);
    const movies = kind === 'movies';
    const [catalog, watchedRows] = await Promise.all([
      movies ? movieCatalog() : cinemaCatalog(),
      movies ? db.listTicketonMovieWatches(chatId) : db.listTicketonCinemaWatches(chatId)
    ]);
    const watched = new Map(watchedRows.map((row) => [
      String(movies ? row.movie_id : row.cinema_id),
      movies ? row.movie_name : row.cinema_name
    ]));
    const merged = new Map(catalog.map((item) => [item.id, item]));
    for (const [id, name] of watched) {
      if (!merged.has(id)) merged.set(id, { id, name: `${name} (не в текущей афише)` });
    }
    const items = Array.from(merged.values());
    const pages = Math.max(Math.ceil(items.length / pageSize), 1);
    const page = pageNumber(requestedPage, pages);
    const visible = items.slice(page * pageSize, (page + 1) * pageSize);
    const prefix = movies ? 'movie' : 'cinema';
    const keyboard = visible.map((item) => [{
      text: `${watched.has(item.id) ? '✅' : '➕'} ${shortLabel(item.name)}`,
      callback_data: `kino:${prefix}:${item.id}:${page}`
    }]);
    if (pages > 1) {
      keyboard.push([
        { text: '⬅️', callback_data: `kino:${kind}:${Math.max(page - 1, 0)}` },
        { text: `${page + 1}/${pages}`, callback_data: `kino:${kind}:${page}` },
        { text: '➡️', callback_data: `kino:${kind}:${Math.min(page + 1, pages - 1)}` }
      ]);
    }
    keyboard.push([{ text: '↩️ Назад', callback_data: 'kino:root' }]);
    return {
      text: movies
        ? '🎬 Выбери фильмы из раздела «Кино» Ticketon для ежечасного наблюдения. ✅ — уже в списке.'
        : '🏢 Выбери кинотеатры Астаны. Если не выбран ни один, проверяются все. ✅ — фильтр включён.',
      reply_markup: { inline_keyboard: keyboard }
    };
  };

  const handleCallback = async ({ chatId, userId, data }) => {
    if (data === 'kino:root') return rootMenu(chatId);
    const parts = String(data || '').split(':');
    if (parts[0] !== 'kino') throw new Error('Unknown cinema callback.');
    if (parts[1] === 'movies' || parts[1] === 'cinemas') {
      return listMenu(chatId, parts[1], parts[2]);
    }
    if (!db || !['movie', 'cinema'].includes(parts[1]) || !/^\d+$/u.test(parts[2] || '')) {
      throw new Error('Invalid cinema callback.');
    }

    const kind = parts[1];
    const catalog = kind === 'movie' ? await movieCatalog() : await cinemaCatalog();
    const currentRows = kind === 'movie'
      ? await db.listTicketonMovieWatches(chatId)
      : await db.listTicketonCinemaWatches(chatId);
    const idField = kind === 'movie' ? 'movie_id' : 'cinema_id';
    const nameField = kind === 'movie' ? 'movie_name' : 'cinema_name';
    const current = currentRows.find((row) => String(row[idField]) === parts[2]);
    const item = catalog.find((entry) => entry.id === parts[2]);
    const name = item?.name || current?.[nameField];
    if (!name) throw new Error('Ticketon item is no longer available.');

    if (kind === 'movie') {
      await db.toggleTicketonMovieWatch({
        chatId,
        movieId: parts[2],
        movieName: name,
        movieSlug: item?.slug || current?.movie_slug,
        userId
      });
      return listMenu(chatId, 'movies', parts[3]);
    }
    await db.toggleTicketonCinemaWatch({ chatId, cinemaId: parts[2], cinemaName: name, userId });
    return listMenu(chatId, 'cinemas', parts[3]);
  };

  const runDueChecks = async ({ notify } = {}) => {
    if (!db) return { sent: 0, skipped: 'disabled' };
    if (typeof notify !== 'function') throw new Error('Cinema monitor requires notify callback.');

    const [movieRows, cinemaRows, currentMovies] = await Promise.all([
      db.listTicketonMovieWatches(),
      db.listTicketonCinemaWatches(),
      movieCatalog()
    ]);
    const moviesByChat = groupRowsByChat(movieRows);
    const cinemasByChat = groupRowsByChat(cinemaRows);
    const cinemaMovies = new Map(currentMovies.map((movie) => [movie.id, movie]));
    const sessionCache = new Map();
    const seatPlanCache = new Map();
    let checkedSessions = 0;
    let sent = 0;
    let failures = 0;
    const instant = now();
    const firstDate = client.today();
    const lastDate = client.addDays(firstDate, lookaheadDays - 1);

    for (const [chatId, watchedMovies] of moviesByChat) {
      const cinemaIds = new Set((cinemasByChat.get(chatId) || []).map((row) => String(row.cinema_id)));
      for (const watchedMovie of watchedMovies) {
        const movie = cinemaMovies.get(String(watchedMovie.movie_id));
        if (!movie) continue;
        const sessionsKey = movie.id;
        let sessionsPromise = sessionCache.get(sessionsKey);
        if (!sessionsPromise) {
          sessionsPromise = client.listSessions(movie.id);
          sessionCache.set(sessionsKey, sessionsPromise);
        }
        let sessions;
        try {
          sessions = await sessionsPromise;
        } catch (error) {
          failures += 1;
          logger.error('Ticketon cinema sessions request failed', {
            movieId: movie.id,
            error: error?.message || String(error)
          });
          continue;
        }

        for (const session of sessions) {
          const sessionId = session.id;
          const cinema = session.cinema;
          const hall = session.hall;
          const sessionTime = Date.parse(session.startTime);
          const presented = sessionPresentation(session, client.timeZone);
          if (!sessionId || !cinema?.id) continue;
          if (session.salesStatus && session.salesStatus !== 'on_sale') continue;
          if (!Number.isFinite(sessionTime) || sessionTime <= instant.getTime()) continue;
          if (presented.date < firstDate || presented.date > lastDate) continue;
          if (cinemaIds.size && !cinemaIds.has(String(cinema.id))) continue;

          const seatKey = String(sessionId);
          let planPromise = seatPlanCache.get(seatKey);
          if (!planPromise) {
            if (checkedSessions >= maxSessionsPerRun) continue;
            checkedSessions += 1;
            planPromise = client.getSeatPlan({ sessionId });
            seatPlanCache.set(seatKey, planPromise);
          }
          let plan;
          try {
            plan = await planPromise;
          } catch (error) {
            failures += 1;
            logger.error('Ticketon cinema seat plan request failed', {
              sessionId: String(sessionId),
              error: error?.message || String(error)
            });
            continue;
          }

          const block = findBlock(plan, adjacentSeats);
          if (!block) continue;
          const notification = {
            chatId,
            sessionId,
            movieId: movie.id,
            cinemaId: cinema.id
          };
          const claimed = await db.claimTicketonNotification(notification);
          if (!claimed) continue;

          const url = client.eventUrl(movie, sessionId);
          const alert = {
            chatId,
            text: alertText({
              movie,
              cinema,
              hall,
              session,
              block,
              url,
              timeZone: client.timeZone
            }),
            movie,
            cinema,
            hall,
            session,
            date: presented.date,
            block,
            url
          };
          try {
            await notify(alert);
            sent += 1;
          } catch (error) {
            await db.releaseTicketonNotification(notification);
            failures += 1;
            logger.error('Ticketon cinema notification failed', {
              chatId,
              sessionId: String(sessionId),
              error: error?.message || String(error)
            });
          }
        }
      }
    }

    await db.deleteTicketonNotificationsBefore?.(client.addDays(client.today(), -90));
    return { sent, checkedSessions, failures };
  };

  const startScheduler = ({ notify, runExclusive } = {}) => {
    if (!db || env.TICKETON_MONITOR_ENABLED === 'false') return () => {};
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (runExclusive) {
          await runExclusive('ticketon-cinema-seat-monitor', () => runDueChecks({ notify }));
        } else {
          await runDueChecks({ notify });
        }
      } catch (error) {
        logger.error('Ticketon cinema scheduler failed', error);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    logger.log('Ticketon cinema scheduler started', {
      intervalMs,
      lookaheadDays,
      cityId: client.cityId,
      cityCode: client.cityCode,
      adjacentSeats
    });
    return () => clearInterval(timer);
  };

  return {
    enabled: Boolean(db),
    monitoringEnabled: Boolean(db && env.TICKETON_MONITOR_ENABLED !== 'false'),
    rootMenu,
    listMenu,
    handleCallback,
    runDueChecks,
    startScheduler
  };
};

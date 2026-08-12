import { findAdjacentSeatBlock } from './seats.js';

const defaultIntervalMs = 60 * 60 * 1000;
const defaultLookaheadDays = 7;
const defaultPageSize = 8;
const defaultManualMaxSessions = 30;
const defaultDailyCheckHour = 9;
const maxDigestLength = 3900;
const sessionTimeOptions = [
  0,
  ...Array.from({ length: 14 }, (_, index) => (index + 10) * 60)
];

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedHour = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 0), 23) : fallback;
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

const calendarDate = (parts) => `${parts.year}-${parts.month}-${parts.day}`;

const sessionMinute = (time) => {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/u);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const sessionTimeLabel = (minute) => {
  const normalized = Number(minute) || 0;
  if (!normalized) return 'любое время';
  return `с ${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
};

const findBlock = (seatPlan, requiredSeats) => {
  for (const section of seatPlan?.sections || []) {
    const block = findAdjacentSeatBlock(section.hallPlan, requiredSeats);
    if (block) return { ...block, sectionId: section.id, sectionName: section.name };
  }
  return null;
};

const digestText = ({ alerts, title, checkedSessions, failures, limitReached, earliestSessionMinute }) => {
  const sorted = [...alerts].sort((left, right) =>
    left.movie.name.localeCompare(right.movie.name, 'ru') ||
    Date.parse(left.session.startTime) - Date.parse(right.session.startTime) ||
    left.cinema.name.localeCompare(right.cinema.name, 'ru'));
  const lines = [title, ''];
  let currentMovieId;
  let shown = 0;

  for (const alert of sorted) {
    const movieId = String(alert.movie.id);
    const movieHeader = currentMovieId === movieId ? [] : [`🎬 ${alert.movie.name}`];
    const hall = alert.hall?.name ? `, ${alert.hall.name}` : '';
    const section = alert.block.sectionName && alert.block.sectionName !== 'Основной'
      ? `, сектор ${alert.block.sectionName}`
      : '';
    const chunk = [
      ...movieHeader,
      `• ${alert.date} ${alert.time} — ${alert.cinema.name}${hall}${section}`,
      `  💺 Ряд ${alert.block.row}, места ${alert.block.places.join(', ')}`,
      `  ${alert.url}`
    ];
    const candidate = [...lines, ...chunk].join('\n');
    if (candidate.length > maxDigestLength - 220) break;
    lines.push(...chunk);
    currentMovieId = movieId;
    shown += 1;
  }

  if (!alerts.length) {
    lines.push('Свободных соседних мест в верхней половине зала сейчас не нашёл.');
  } else if (shown < alerts.length) {
    lines.push(`…и ещё ${alerts.length - shown} сеансов не поместились в лимит одного сообщения.`);
  }

  lines.push('', `Проверено сеансов: ${checkedSessions}. С хорошими местами: ${alerts.length}.`);
  lines.push(`Фильтр времени: ${sessionTimeLabel(earliestSessionMinute)}.`);
  if (limitReached) lines.push('⚠️ Достигнут лимит карт зала за одну проверку.');
  if (failures) lines.push(`⚠️ Не удалось проверить запросов: ${failures}.`);
  return lines.join('\n').slice(0, maxDigestLength);
};

const availabilityAlert = ({ chatId, movie, cinema, hall, session, block, url, timeZone }) => {
  const starts = sessionPresentation(session, timeZone);
  const section = block.sectionName && block.sectionName !== 'Основной'
    ? block.sectionName
    : null;
  return {
    chatId,
    movie,
    cinema,
    hall,
    session,
    date: starts.date,
    time: starts.time,
    block: { ...block, sectionName: section },
    url
  };
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
  const dailyCheckHour = boundedHour(env.TICKETON_DAILY_CHECK_HOUR, defaultDailyCheckHour);
  const lookaheadDays = Math.min(positiveInteger(env.TICKETON_LOOKAHEAD_DAYS, defaultLookaheadDays), 31);
  const adjacentSeats = Math.min(positiveInteger(env.TICKETON_ADJACENT_SEATS, 2), 12);
  const pageSize = Math.min(positiveInteger(env.TICKETON_MENU_PAGE_SIZE, defaultPageSize), 20);
  const maxSessionsPerRun = positiveInteger(env.TICKETON_MAX_SESSIONS_PER_RUN, 300);
  const manualMaxSessions = Math.min(
    positiveInteger(env.TICKETON_MANUAL_MAX_SESSIONS, defaultManualMaxSessions),
    maxSessionsPerRun
  );
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
    const [movies, cinemas, preferences] = await Promise.all([
      db.listTicketonMovieWatches(chatId),
      db.listTicketonCinemaWatches(chatId),
      db.getTicketonChatPreferences(chatId)
    ]);
    const earliestSessionMinute = Number(preferences?.earliest_session_minute) || 0;
    const movieLines = watchedSummary(movies, 'movie_name', 'пока пусто');
    const cinemaLines = watchedSummary(cinemas, 'cinema_name', 'все кинотеатры');
    return {
      text: [
        '🎟 Монитор Ticketon — только кино в Астане',
        `🌅 Один общий дайджест в день после ${String(dailyCheckHour).padStart(2, '0')}:00.`,
        '',
        'Наблюдаемые фильмы:',
        ...movieLines,
        '',
        'Фильтр кинотеатров:',
        ...cinemaLines,
        '',
        `Время сеансов: ${sessionTimeLabel(earliestSessionMinute)}`
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎬 Фильмы (${movies.length})`, callback_data: 'kino:movies:0' }],
          [{ text: `🏢 Кинотеатры (${cinemas.length || 'все'})`, callback_data: 'kino:cinemas:0' }],
          [{ text: `🕒 Время (${sessionTimeLabel(earliestSessionMinute)})`, callback_data: 'kino:times' }],
          [{ text: '🔎 Проверить сейчас', callback_data: 'kino:check' }],
          [{ text: '🔄 Обновить', callback_data: 'kino:root' }]
        ]
      }
    };
  };

  const timeMenu = async (chatId) => {
    if (!db) return rootMenu(chatId);
    const preferences = await db.getTicketonChatPreferences(chatId);
    const current = Number(preferences?.earliest_session_minute) || 0;
    const buttons = sessionTimeOptions.map((minute) => ({
      text: `${current === minute ? '✅' : '▫️'} ${sessionTimeLabel(minute)}`,
      callback_data: `kino:time:${minute}`
    }));
    const keyboard = [];
    for (let index = 0; index < buttons.length; index += 2) {
      keyboard.push(buttons.slice(index, index + 2));
    }
    keyboard.push([{ text: '↩️ Назад', callback_data: 'kino:root' }]);
    return {
      text: [
        '🕒 Минимальное время начала сеанса',
        '',
        'Сеансы раньше выбранного времени не проверяются ни вручную, ни в утреннем дайджесте.',
        `Сейчас: ${sessionTimeLabel(current)}.`
      ].join('\n'),
      reply_markup: { inline_keyboard: keyboard }
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
        ? '🎬 Выбери фильмы из раздела «Кино» Ticketon для ежедневного утреннего дайджеста. ✅ — уже в списке.'
        : '🏢 Выбери кинотеатры Астаны. Если не выбран ни один, проверяются все. ✅ — фильтр включён.',
      reply_markup: { inline_keyboard: keyboard }
    };
  };

  const handleCallback = async ({ chatId, userId, data }) => {
    if (data === 'kino:root') return rootMenu(chatId);
    if (data === 'kino:times') return timeMenu(chatId);
    const parts = String(data || '').split(':');
    if (parts[0] !== 'kino') throw new Error('Unknown cinema callback.');
    if (parts[1] === 'movies' || parts[1] === 'cinemas') {
      return listMenu(chatId, parts[1], parts[2]);
    }
    if (parts[1] === 'time') {
      const minute = Number(parts[2]);
      if (!db || !sessionTimeOptions.includes(minute)) throw new Error('Invalid cinema time callback.');
      await db.setTicketonEarliestSessionTime({ chatId, earliestSessionMinute: minute, userId });
      return timeMenu(chatId);
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

  const scanAvailability = async ({ chatId, maxSessions = maxSessionsPerRun, instant = now() } = {}) => {
    if (!db) return { watchedMovies: 0, availableSessions: 0, sent: 0, checkedSessions: 0, failures: 0, skipped: 'disabled' };

    const [movieRows, cinemaRows] = await Promise.all([
      db.listTicketonMovieWatches(chatId),
      db.listTicketonCinemaWatches(chatId)
    ]);
    if (!movieRows.length) {
      return { watchedMovies: 0, availableSessions: 0, checkedSessions: 0, failures: 0, alerts: [] };
    }

    const currentMovies = await movieCatalog();
    const moviesByChat = groupRowsByChat(movieRows);
    const cinemasByChat = groupRowsByChat(cinemaRows);
    const cinemaMovies = new Map(currentMovies.map((movie) => [movie.id, movie]));
    const sessionCache = new Map();
    const seatPlanCache = new Map();
    const sessionLimit = positiveInteger(maxSessions, maxSessionsPerRun);
    let checkedSessions = 0;
    let failures = 0;
    let limitReached = false;
    const alerts = [];
    const earliestByChat = new Map();
    const firstDate = calendarDate(localTimeParts(instant, client.timeZone));
    const lastDate = client.addDays(firstDate, lookaheadDays - 1);

    for (const [targetChatId, watchedMovies] of moviesByChat) {
      const preferences = await db.getTicketonChatPreferences(targetChatId);
      const earliestSessionMinute = Number(preferences?.earliest_session_minute) || 0;
      earliestByChat.set(targetChatId, earliestSessionMinute);
      const cinemaIds = new Set((cinemasByChat.get(targetChatId) || []).map((row) => String(row.cinema_id)));
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
          const startsAtMinute = sessionMinute(presented.time);
          if (startsAtMinute === null || startsAtMinute < earliestSessionMinute) continue;

          const seatKey = String(sessionId);
          let planPromise = seatPlanCache.get(seatKey);
          if (!planPromise) {
            if (checkedSessions >= sessionLimit) {
              limitReached = true;
              continue;
            }
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
          const url = client.eventUrl(movie, sessionId);
          alerts.push(availabilityAlert({
            chatId: targetChatId,
            movie,
            cinema,
            hall,
            session,
            block,
            url,
            timeZone: client.timeZone
          }));
        }
      }
    }

    return {
      watchedMovies: movieRows.length,
      availableSessions: alerts.length,
      checkedSessions,
      failures,
      limitReached,
      alerts,
      earliestSessionMinute: earliestByChat.get(String(chatId)) || 0
    };
  };

  const runManualCheck = async ({ chatId } = {}) => {
    const result = await scanAvailability({ chatId, maxSessions: manualMaxSessions });
    if (!result.watchedMovies) {
      return {
        ...result,
        text: 'Сначала выбери хотя бы один фильм через кнопку «Фильмы», а потом запускай проверку.'
      };
    }

    return {
      ...result,
      text: digestText({
        alerts: result.alerts,
        title: '🔎 Ручная проверка Ticketon',
        checkedSessions: result.checkedSessions,
        failures: result.failures,
        limitReached: result.limitReached,
        earliestSessionMinute: result.earliestSessionMinute
      })
    };
  };

  const runDueChecks = async ({ notify, instant = now() } = {}) => {
    if (!db || env.TICKETON_MONITOR_ENABLED === 'false') return { sent: 0, skipped: 'disabled' };
    if (typeof notify !== 'function') throw new Error('Cinema monitor requires notify callback.');

    const local = localTimeParts(instant, client.timeZone);
    if (Number(local.hour) < dailyCheckHour) return { sent: 0, skipped: 'before_check_hour' };

    const digestDate = calendarDate(local);
    const movieRows = await db.listTicketonMovieWatches();
    const chatIds = [...new Set(movieRows.map((row) => String(row.chat_id)))];
    let sent = 0;
    let processedChats = 0;
    let checkedSessions = 0;
    let availableSessions = 0;
    let failures = 0;

    for (const chatId of chatIds) {
      const claimed = await db.claimTicketonDailyDigest({ chatId, digestDate });
      if (!claimed) continue;
      processedChats += 1;

      try {
        const result = await scanAvailability({ chatId, maxSessions: maxSessionsPerRun, instant });
        checkedSessions += result.checkedSessions;
        availableSessions += result.availableSessions;
        failures += result.failures;
        if (!result.alerts.length) continue;

        const notification = {
          chatId,
          text: digestText({
            alerts: result.alerts,
            title: `🌅 Утренний дайджест Ticketon — ${digestDate}`,
            checkedSessions: result.checkedSessions,
            failures: result.failures,
            limitReached: result.limitReached,
            earliestSessionMinute: result.earliestSessionMinute
          }),
          alerts: result.alerts,
          digestDate
        };
        await notify(notification);
        sent += 1;
      } catch (error) {
        await db.releaseTicketonDailyDigest({ chatId, digestDate });
        failures += 1;
        logger.error('Ticketon daily digest failed', {
          chatId,
          digestDate,
          error: error?.message || String(error)
        });
      }
    }

    await db.deleteTicketonDailyDigestsBefore?.(client.addDays(digestDate, -400));
    return { sent, processedChats, checkedSessions, availableSessions, failures };
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
      dailyCheckHour,
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
    timeMenu,
    handleCallback,
    runDueChecks,
    runManualCheck,
    startScheduler
  };
};

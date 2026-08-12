import assert from 'node:assert/strict';
import test from 'node:test';
import { createTicketonCinemaMonitorService } from '../src/kino/service.js';

const movie = {
  chat_id: '-100',
  movie_id: '10',
  movie_name: 'Тестовый фильм',
  movie_slug: 'test-film'
};
const cinema = { chat_id: '-100', cinema_id: '20', cinema_name: 'Тестовый кинотеатр' };

const createDb = () => {
  const dailyDigests = new Set();
  return {
    movies: [movie],
    cinemas: [cinema],
    preferences: new Map(),
    async listTicketonMovieWatches(chatId) {
      return chatId === undefined ? this.movies : this.movies.filter((row) => String(row.chat_id) === String(chatId));
    },
    async listTicketonCinemaWatches(chatId) {
      return chatId === undefined ? this.cinemas : this.cinemas.filter((row) => String(row.chat_id) === String(chatId));
    },
    async toggleTicketonMovieWatch() { return true; },
    async toggleTicketonCinemaWatch() { return true; },
    async getTicketonChatPreferences(chatId) {
      const preferences = this.preferences.get(String(chatId));
      if (preferences === undefined) return null;
      if (typeof preferences === 'number') {
        return { chat_id: String(chatId), earliest_session_minute: preferences, adjacent_seats: 2 };
      }
      return { chat_id: String(chatId), earliest_session_minute: 0, adjacent_seats: 2, ...preferences };
    },
    async setTicketonEarliestSessionTime({ chatId, earliestSessionMinute }) {
      const current = await this.getTicketonChatPreferences(chatId);
      const preferences = { ...current, earliest_session_minute: earliestSessionMinute };
      this.preferences.set(String(chatId), preferences);
      return preferences;
    },
    async setTicketonAdjacentSeats({ chatId, adjacentSeats }) {
      const current = await this.getTicketonChatPreferences(chatId);
      const preferences = { ...current, adjacent_seats: adjacentSeats };
      this.preferences.set(String(chatId), preferences);
      return preferences;
    },
    async claimTicketonDailyDigest({ chatId, digestDate }) {
      const key = `${chatId}:${digestDate}`;
      if (dailyDigests.has(key)) return false;
      dailyDigests.add(key);
      return true;
    },
    async releaseTicketonDailyDigest({ chatId, digestDate }) {
      dailyDigests.delete(`${chatId}:${digestDate}`);
    },
    async deleteTicketonDailyDigestsBefore() {}
  };
};

const createClient = () => ({
  cityId: 1,
  cityCode: 'astana',
  timeZone: 'Asia/Almaty',
  today: () => '2026-08-12',
  addDays: (date, days) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  },
  async listMovies() {
    return [{ id: 10, name: 'Тестовый фильм', slug: 'test-film' }];
  },
  async listCinemas() {
    return [{ id: 20, name: 'Тестовый кинотеатр' }];
  },
  async listSessions() {
    return [{
      id: 30,
      date: '2026-08-12',
      startTime: '2026-08-12T20:15:00+05:00',
      salesStatus: 'on_sale',
      cinema: { id: 20, name: 'Тестовый кинотеатр' },
      hall: { id: 40, name: 'Зал 1' }
    }];
  },
  async getSeatPlan() {
    return {
      sections: [{
        id: '50',
        name: 'Основной',
        hallPlan: {
          places: [
            { id: '1', row: '1', place: '1', status: 0, x: 0, width: 20 },
            { id: '2', row: '2', place: '7', status: 1, x: 0, width: 20 },
            { id: '3', row: '2', place: '8', status: 1, x: 24, width: 20 }
          ]
        }
      }]
    };
  },
  eventUrl: ({ slug }, sessionId) => `https://ticketon.kz/cinema/event/${slug}/session/${sessionId}`
});

test('Ticketon cinema monitor sends one combined morning digest per chat and day', async () => {
  const db = createDb();
  const client = createClient();
  client.listSessions = async () => [
    ...(await createClient().listSessions()),
    {
      id: 31,
      date: '2026-08-12',
      startTime: '2026-08-12T21:15:00+05:00',
      salesStatus: 'on_sale',
      cinema: { id: 20, name: 'Тестовый кинотеатр' },
      hall: { id: 41, name: 'Зал 2' }
    }
  ];
  const service = createTicketonCinemaMonitorService({
    db,
    client,
    env: { TICKETON_LOOKAHEAD_DAYS: '2' },
    now: () => new Date('2026-08-12T05:00:00Z')
  });
  const alerts = [];

  const first = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });
  const second = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });

  assert.equal(first.sent, 1);
  assert.equal(first.availableSessions, 2);
  assert.equal(second.sent, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Ряд 2, места 7, 8/u);
  assert.match(alerts[0].text, /Утренний дайджест Ticketon/u);
  assert.match(alerts[0].text, /session\/30/u);
  assert.match(alerts[0].text, /session\/31/u);
  assert.equal(alerts[0].alerts.length, 2);
  assert.equal(alerts[0].alerts[0].url, 'https://ticketon.kz/cinema/event/test-film/session/30');
});

test('Ticketon cinema monitor waits for morning and retries a failed digest delivery', async () => {
  const db = createDb();
  const service = createTicketonCinemaMonitorService({
    db,
    client: createClient(),
    env: { TICKETON_DAILY_CHECK_HOUR: '9' },
    now: () => new Date('2026-08-12T05:00:00Z'),
    logger: { error() {}, log() {} }
  });
  let attempts = 0;

  const early = await service.runDueChecks({
    instant: new Date('2026-08-12T03:00:00Z'),
    notify: async () => {}
  });
  const failed = await service.runDueChecks({
    notify: async () => {
      attempts += 1;
      throw new Error('Telegram unavailable');
    }
  });
  const retried = await service.runDueChecks({
    notify: async () => { attempts += 1; }
  });

  assert.equal(early.skipped, 'before_check_hour');
  assert.equal(failed.sent, 0);
  assert.equal(failed.failures, 1);
  assert.equal(retried.sent, 1);
  assert.equal(attempts, 2);
});

test('Ticketon morning digest repeats a still-available future session on the next day', async () => {
  const client = createClient();
  client.listSessions = async () => [{
    id: 32,
    date: '2026-08-13',
    startTime: '2026-08-13T20:15:00+05:00',
    salesStatus: 'on_sale',
    cinema: { id: 20, name: 'Тестовый кинотеатр' },
    hall: { id: 40, name: 'Зал 1' }
  }];
  const service = createTicketonCinemaMonitorService({ db: createDb(), client });
  const digests = [];

  const first = await service.runDueChecks({
    instant: new Date('2026-08-12T05:00:00Z'),
    notify: async (digest) => digests.push(digest)
  });
  const second = await service.runDueChecks({
    instant: new Date('2026-08-13T05:00:00Z'),
    notify: async (digest) => digests.push(digest)
  });

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 1);
  assert.equal(digests.length, 2);
  assert.equal(digests[0].alerts[0].session.id, 32);
  assert.equal(digests[1].alerts[0].session.id, 32);
});

test('Ticketon cinema monitor ignores watches absent from the cinema-only catalog', async () => {
  const client = createClient();
  client.listMovies = async () => [];
  let sessionCalls = 0;
  client.listSessions = async () => {
    sessionCalls += 1;
    return [];
  };
  const service = createTicketonCinemaMonitorService({
    db: createDb(),
    client,
    now: () => new Date('2026-08-12T05:00:00Z')
  });

  const result = await service.runDueChecks({ notify: async () => {} });

  assert.equal(result.sent, 0);
  assert.equal(sessionCalls, 0);
});

test('Ticketon cinema menus mark watched items and explain empty cinema filter', async () => {
  const db = createDb();
  db.cinemas = [];
  const service = createTicketonCinemaMonitorService({ db, client: createClient() });

  const root = await service.rootMenu('-100');
  const movies = await service.listMenu('-100', 'movies', 0);

  assert.match(root.text, /только кино в Астане/u);
  assert.match(root.text, /все кинотеатры/u);
  assert.equal(movies.reply_markup.inline_keyboard[0][0].text, '✅ Тестовый фильм');
  assert.equal(movies.reply_markup.inline_keyboard[0][0].callback_data, 'kino:movie:10:0');
  assert.equal(root.reply_markup.inline_keyboard[2][0].callback_data, 'kino:times');
  assert.equal(root.reply_markup.inline_keyboard[3][0].callback_data, 'kino:seats');
  assert.equal(root.reply_markup.inline_keyboard[4][0].callback_data, 'kino:check');
});

test('Ticketon cinema time menu stores a shared earliest session time', async () => {
  const db = createDb();
  const service = createTicketonCinemaMonitorService({ db, client: createClient() });

  const selected = await service.handleCallback({
    chatId: '-100',
    userId: '7',
    data: 'kino:time:1080'
  });
  const root = await service.rootMenu('-100');

  assert.equal(db.preferences.get('-100').earliest_session_minute, 1080);
  assert.match(selected.text, /Сейчас: с 18:00/u);
  assert.match(root.text, /Время сеансов: с 18:00/u);
  assert.match(root.reply_markup.inline_keyboard[2][0].text, /с 18:00/u);
});

test('Ticketon cinema seats menu stores the required adjacent block size', async () => {
  const db = createDb();
  const service = createTicketonCinemaMonitorService({ db, client: createClient() });

  const selected = await service.handleCallback({
    chatId: '-100',
    userId: '7',
    data: 'kino:seats:4'
  });
  const root = await service.rootMenu('-100');

  assert.equal(db.preferences.get('-100').adjacent_seats, 4);
  assert.match(selected.text, /Сейчас: 4/u);
  assert.match(root.text, /Мест рядом: 4/u);
  assert.match(root.reply_markup.inline_keyboard[3][0].text, /Мест рядом \(4\)/u);
});

test('Ticketon cinema monitor applies the chat adjacent seat preference', async () => {
  const db = createDb();
  db.preferences.set('-100', { earliest_session_minute: 0, adjacent_seats: 3 });
  const service = createTicketonCinemaMonitorService({
    db,
    client: createClient(),
    now: () => new Date('2026-08-12T05:00:00Z')
  });

  const result = await service.runManualCheck({ chatId: '-100' });

  assert.equal(result.adjacentSeats, 3);
  assert.equal(result.availableSessions, 0);
  assert.match(result.text, /Мест рядом: 3/u);
});

test('Ticketon cinema monitor skips sessions earlier than the chat preference', async () => {
  const db = createDb();
  db.preferences.set('-100', 18 * 60);
  const client = createClient();
  client.listSessions = async () => [
    {
      id: 29,
      date: '2026-08-12',
      startTime: '2026-08-12T11:00:00+05:00',
      salesStatus: 'on_sale',
      cinema: { id: 20, name: 'Тестовый кинотеатр' },
      hall: { id: 39, name: 'Утренний зал' }
    },
    ...(await createClient().listSessions())
  ];
  const requestedSessions = [];
  client.getSeatPlan = async ({ sessionId }) => {
    requestedSessions.push(Number(sessionId));
    return createClient().getSeatPlan();
  };
  const service = createTicketonCinemaMonitorService({
    db,
    client,
    now: () => new Date('2026-08-12T05:00:00Z')
  });

  const result = await service.runManualCheck({ chatId: '-100' });

  assert.deepEqual(requestedSessions, [30]);
  assert.equal(result.availableSessions, 1);
  assert.equal(result.alerts[0].session.id, 30);
  assert.match(result.text, /Фильтр времени: с 18:00/u);
  assert.doesNotMatch(result.text, /Утренний зал/u);
});

test('manual Ticketon check is scoped to one chat and combines results into one message', async () => {
  const db = createDb();
  db.movies.push({ ...movie, chat_id: '-200', movie_id: '11', movie_name: 'Чужой фильм' });
  const client = createClient();
  const requestedMovies = [];
  client.listMovies = async () => [
    { id: 10, name: 'Тестовый фильм', slug: 'test-film' },
    { id: 11, name: 'Чужой фильм', slug: 'other-film' }
  ];
  client.listSessions = async (movieId) => {
    requestedMovies.push(String(movieId));
    return createClient().listSessions();
  };
  const service = createTicketonCinemaMonitorService({
    db,
    client,
    now: () => new Date('2026-08-12T05:00:00Z')
  });
  const first = await service.runManualCheck({ chatId: '-100' });
  const second = await service.runManualCheck({ chatId: '-100' });

  assert.deepEqual(requestedMovies, ['10', '10']);
  assert.equal(first.watchedMovies, 1);
  assert.equal(first.availableSessions, 1);
  assert.equal(second.availableSessions, 1);
  assert.match(first.text, /Проверено сеансов: 1/u);
  assert.match(first.text, /Тестовый фильм/u);
  assert.match(first.text, /session\/30/u);
  assert.equal(first.text, second.text);
});

test('manual Ticketon check asks to select a movie when the chat watchlist is empty', async () => {
  const service = createTicketonCinemaMonitorService({ db: createDb(), client: createClient() });

  const result = await service.runManualCheck({ chatId: '-404' });

  assert.equal(result.checkedSessions, 0);
  assert.match(result.text, /Сначала выбери хотя бы один фильм/u);
});

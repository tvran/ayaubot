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
  const notifications = new Set();
  return {
    movies: [movie],
    cinemas: [cinema],
    async listTicketonMovieWatches(chatId) {
      return chatId === undefined ? this.movies : this.movies.filter((row) => String(row.chat_id) === String(chatId));
    },
    async listTicketonCinemaWatches(chatId) {
      return chatId === undefined ? this.cinemas : this.cinemas.filter((row) => String(row.chat_id) === String(chatId));
    },
    async toggleTicketonMovieWatch() { return true; },
    async toggleTicketonCinemaWatch() { return true; },
    async claimTicketonNotification({ chatId, sessionId }) {
      const key = `${chatId}:${sessionId}`;
      if (notifications.has(key)) return false;
      notifications.add(key);
      return true;
    },
    async releaseTicketonNotification({ chatId, sessionId }) {
      notifications.delete(`${chatId}:${sessionId}`);
    },
    async deleteTicketonNotificationsBefore() {}
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

test('Ticketon cinema monitor filters venues, finds adjacent seats and deduplicates alerts', async () => {
  const db = createDb();
  const service = createTicketonCinemaMonitorService({
    db,
    client: createClient(),
    env: { TICKETON_LOOKAHEAD_DAYS: '2' },
    now: () => new Date('2026-08-12T05:00:00Z')
  });
  const alerts = [];

  const first = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });
  const second = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Ряд 2, места 7, 8/u);
  assert.equal(alerts[0].url, 'https://ticketon.kz/cinema/event/test-film/session/30');
});

test('Ticketon cinema monitor ignores watches absent from the cinema-only catalog', async () => {
  const client = createClient();
  client.listMovies = async () => [];
  let sessionCalls = 0;
  client.listSessions = async () => {
    sessionCalls += 1;
    return [];
  };
  const service = createTicketonCinemaMonitorService({ db: createDb(), client });

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
});

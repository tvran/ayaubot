import assert from 'node:assert/strict';
import test from 'node:test';
import { createKinoMonitorService } from '../src/kino/service.js';

const movie = { chat_id: '-100', movie_id: '10', movie_name: 'Тестовый фильм' };
const cinema = { chat_id: '-100', cinema_id: '20', cinema_name: 'Тестовый кинотеатр' };

const createDb = () => {
  const notifications = new Set();
  return {
    movies: [movie],
    cinemas: [cinema],
    async listKinoMovieWatches(chatId) {
      return chatId === undefined ? this.movies : this.movies.filter((row) => String(row.chat_id) === String(chatId));
    },
    async listKinoCinemaWatches(chatId) {
      return chatId === undefined ? this.cinemas : this.cinemas.filter((row) => String(row.chat_id) === String(chatId));
    },
    async toggleKinoMovieWatch() { return true; },
    async toggleKinoCinemaWatch() { return true; },
    async claimKinoNotification({ chatId, sessionId }) {
      const key = `${chatId}:${sessionId}`;
      if (notifications.has(key)) return false;
      notifications.add(key);
      return true;
    },
    async releaseKinoNotification({ chatId, sessionId }) {
      notifications.delete(`${chatId}:${sessionId}`);
    },
    async deleteKinoNotificationsBefore() {}
  };
};

const createClient = () => ({
  baseUrl: 'https://kino.kz',
  cityId: 2,
  timeZone: 'Asia/Almaty',
  seatPlansEnabled: true,
  today: () => '2026-08-12',
  addDays: (date, days) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  },
  async listMovies() { return [{ id: 10, name: 'Тестовый фильм' }]; },
  async listCinemas() { return [{ id: 20, name: 'Тестовый кинотеатр' }]; },
  async listSessions(movieId, date) {
    return date === '2026-08-12' ? [{
      session: { session_id: 30, hour: '20', minutes: '15', cinema_id: 20 },
      cinema: { id: 20, name: 'Тестовый кинотеатр' },
      hall: { name: 'Зал 1' }
    }] : [];
  },
  async getSeatPlan() {
    return {
      hall_plan: {
        places: [
          { id: '1', row: '1', place: '1', status: 0, x: 0, width: 20 },
          { id: '2', row: '2', place: '7', status: 1, x: 0, width: 20 },
          { id: '3', row: '2', place: '8', status: 1, x: 24, width: 20 }
        ]
      }
    };
  }
});

test('kino monitor filters cinemas, finds adjacent seats and deduplicates alerts', async () => {
  const db = createDb();
  const service = createKinoMonitorService({
    db,
    client: createClient(),
    env: { KINO_LOOKAHEAD_DAYS: '2' },
    now: () => new Date('2026-08-12T05:00:00Z')
  });
  const alerts = [];

  const first = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });
  const second = await service.runDueChecks({ notify: async (alert) => alerts.push(alert) });

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Ряд 2, места 7, 8/u);
  assert.match(alerts[0].url, /movie\/10\/tickets\/30/u);
});

test('kino menus mark watched items and explain empty cinema filter', async () => {
  const db = createDb();
  db.cinemas = [];
  const service = createKinoMonitorService({ db, client: createClient() });

  const root = await service.rootMenu('-100');
  const movies = await service.listMenu('-100', 'movies', 0);

  assert.match(root.text, /все кинотеатры/u);
  assert.equal(movies.reply_markup.inline_keyboard[0][0].text, '✅ Тестовый фильм');
  assert.equal(movies.reply_markup.inline_keyboard[0][0].callback_data, 'kino:movie:10:0');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createBirthdayService, parseBirthdayDate } from '../src/birthday/service.js';

const message = {
  chat: { id: -1001, type: 'supergroup', title: 'Тестовый чат' },
  from: { id: 10, first_name: 'Аяу', last_name: 'Тест', username: 'ayau' }
};

test('parseBirthdayDate accepts full and short dates and validates leap days', () => {
  assert.deepEqual(parseBirthdayDate('14.07.1995', { currentYear: 2026 }), {
    day: 14,
    month: 7,
    year: 1995
  });
  assert.deepEqual(parseBirthdayDate('29/02', { currentYear: 2026 }), {
    day: 29,
    month: 2,
    year: null
  });
  assert.throws(
    () => parseBirthdayDate('29.02.2025', { currentYear: 2026 }),
    /Такой даты/
  );
  assert.throws(
    () => parseBirthdayDate('01.01.2030', { currentYear: 2026 }),
    /Год должен быть/
  );
});

test('register stores a birthday and explains private reminders', async () => {
  let stored;
  const service = createBirthdayService({
    db: {
      async upsertBirthday(value) {
        stored = value;
      }
    },
    env: { BIRTHDAY_TIME_ZONE: 'UTC' },
    now: () => new Date('2026-07-14T12:00:00Z')
  });

  const response = await service.register(message, '14.07.1995');

  assert.deepEqual(stored, {
    chatId: -1001,
    chatTitle: 'Тестовый чат',
    user: message.from,
    day: 14,
    month: 7,
    year: 1995
  });
  assert.match(response, /Запомнил/);
  assert.match(response, /нажать Start/);
});

test('scheduler sends one group congratulation and private reminders only once', async () => {
  const todayBirthday = {
    chat_id: '-1001',
    chat_title: 'Тестовый чат',
    user_id: '10',
    first_name: 'Аяу',
    last_name: 'Тест',
    username: 'ayau',
    birth_day: 14,
    birth_month: 7,
    birth_year: 1995
  };
  const tomorrowBirthday = {
    ...todayBirthday,
    user_id: '20',
    first_name: 'Мира',
    last_name: null,
    username: 'mira',
    birth_day: 15,
    birth_year: null
  };
  const claims = new Set();
  const db = {
    async birthdaysForDate({ month, day }) {
      if (month === 7 && day === 14) return [todayBirthday];
      if (month === 7 && day === 15) return [tomorrowBirthday];
      return [];
    },
    async birthdayReminderRecipients() {
      return [
        { user_id: '10', first_name: 'Аяу' },
        { user_id: '30', first_name: 'Лена' }
      ];
    },
    async claimBirthdayNotification(notification) {
      const key = JSON.stringify(notification);
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    async releaseBirthdayNotification(notification) {
      claims.delete(JSON.stringify(notification));
    },
    async deleteBirthdayNotificationsBefore() {}
  };
  const service = createBirthdayService({
    db,
    env: { BIRTHDAY_TIME_ZONE: 'UTC', BIRTHDAY_CHECK_HOUR: '9' }
  });
  const sent = [];
  const sendMessage = async (chatId, text, extra) => sent.push({ chatId, text, extra });

  const first = await service.runDueNotifications({
    sendMessage,
    instant: new Date('2026-07-14T09:00:00Z')
  });
  const second = await service.runDueNotifications({
    sendMessage,
    instant: new Date('2026-07-14T12:00:00Z')
  });

  assert.equal(first.sent, 3);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].chatId, '-1001');
  assert.equal(sent[0].extra.parse_mode, 'HTML');
  assert.match(sent[0].text, /С днём рождения/);
  assert.deepEqual(sent.slice(1).map(({ chatId }) => chatId), ['10', '30']);
  assert.match(sent[1].text, /Завтра день рождения у Мира/);
});

test('scheduler waits until the configured local hour', async () => {
  let queried = false;
  const service = createBirthdayService({
    db: {
      async birthdaysForDate() {
        queried = true;
        return [];
      }
    },
    env: { BIRTHDAY_TIME_ZONE: 'UTC', BIRTHDAY_CHECK_HOUR: '9' }
  });

  const result = await service.runDueNotifications({
    sendMessage: async () => {},
    instant: new Date('2026-07-14T08:59:00Z')
  });

  assert.deepEqual(result, { sent: 0, skipped: 'before_check_hour' });
  assert.equal(queried, false);
});

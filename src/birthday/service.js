const monthNames = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря'
];

const defaultTimeZone = 'Asia/Almaty';
const defaultCheckHour = 9;
const defaultCheckIntervalMs = 15 * 60 * 1000;

const asInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const displayName = (user = {}) =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') ||
  (user.username ? `@${user.username}` : `пользователь ${user.user_id || user.id}`);

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const calendarDate = ({ year, month, day }) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const addCalendarDays = (parts, days) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
};

const zonedDateParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour
  };
};

const dateLabel = ({ birth_day: day, birth_month: month, birth_year: year }) =>
  `${day} ${monthNames[month - 1]}${year ? ` ${year}` : ''}`;

const ageWord = (age) => {
  const mod100 = age % 100;
  const mod10 = age % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'лет';
  if (mod10 === 1) return 'год';
  if (mod10 >= 2 && mod10 <= 4) return 'года';
  return 'лет';
};

const birthdayAge = (birthday, targetYear) => {
  if (!birthday.birth_year) return null;
  const age = targetYear - Number(birthday.birth_year);
  return age > 0 ? age : null;
};

const isPermanentTelegramError = (error) =>
  /forbidden|chat not found|bot was blocked|user is deactivated/i.test(error?.message || '');

export const parseBirthdayDate = (value, { currentYear = new Date().getUTCFullYear() } = {}) => {
  const match = String(value || '').trim().match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?$/);
  if (!match) {
    throw new Error('Укажи дату в формате ДД.ММ.ГГГГ, например /birthday 14.07.1995. Год можно не писать.');
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3] ? Number(match[3]) : null;
  const validationYear = year || 2000;
  const date = new Date(Date.UTC(validationYear, month - 1, day));
  const validDate = date.getUTCFullYear() === validationYear &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  if (!validDate || month < 1 || month > 12 || day < 1) {
    throw new Error('Такой даты в календаре нет. Попробуй ещё раз в формате ДД.ММ.ГГГГ.');
  }
  if (year && (year < 1900 || year > currentYear)) {
    throw new Error(`Год должен быть от 1900 до ${currentYear}. Если не хочешь его указывать, напиши только ДД.ММ.`);
  }

  return { day, month, year };
};

const reminderText = (birthday, targetYear) => {
  const name = displayName(birthday);
  const chat = birthday.chat_title ? ` в чате «${birthday.chat_title}»` : '';
  const age = birthdayAge(birthday, targetYear);
  const ageText = age ? ` Ему/ей исполнится ${age} ${ageWord(age)}.` : '';
  return [
    '🎂 Напоминание на завтра!',
    '',
    `Завтра день рождения у ${name}${chat}.${ageText}`,
    'Самое время приготовить поздравление, подарок или хотя бы достойный стикер ✨'
  ].join('\n');
};

const congratulationText = (birthday, targetYear) => {
  const name = escapeHtml(displayName(birthday));
  const userId = birthday.user_id;
  const age = birthdayAge(birthday, targetYear);
  const ageText = age ? ` Сегодня тебе ${age} ${ageWord(age)} — звучит солидно, выглядит великолепно!` : '';
  return [
    '🎉🎊🎂 <b>ВНИМАНИЕ, ПРАЗДНИЧНЫЙ ПЕРЕПОЛОХ!</b> 🎂🎊🎉',
    '',
    `Сегодня день рождения у <a href="tg://user?id=${userId}">${name}</a>!${ageText}`,
    '',
    'Пусть денег будет с запасом, приключений — только приятных, здоровья — железного, а поводов смеяться — каждый день.',
    'Желаем, чтобы мечты не пылились в черновиках, а нагло становились реальностью! 🚀',
    '',
    '🥳 <b>С днём рождения!</b> Чат, навалите поздравлений, огня и лучших стикеров! 🥂🎁✨'
  ].join('\n');
};

export const createBirthdayService = ({ db, env = process.env, now = () => new Date(), logger = console } = {}) => {
  const timeZone = env.BIRTHDAY_TIME_ZONE || defaultTimeZone;
  const checkHour = Math.min(Math.max(asInteger(env.BIRTHDAY_CHECK_HOUR, defaultCheckHour), 0), 23);
  const checkIntervalMs = Math.max(asInteger(env.BIRTHDAY_CHECK_INTERVAL_MS, defaultCheckIntervalMs), 60_000);
  const schedulerEnabled = env.BIRTHDAY_SCHEDULER_ENABLED !== 'false';

  const unavailableText = 'Напоминания о днях рождения пока не настроены: админу нужно подключить PostgreSQL.';

  const register = async (message, rawDate) => {
    if (!db) return unavailableText;
    if (!['group', 'supergroup'].includes(message.chat?.type)) {
      return 'День рождения нужно зарегистрировать командой в групповом чате, где я состою.';
    }
    if (!message.from?.id) return 'Не смог определить, кто отправил команду. Попробуй ещё раз обычным сообщением.';

    const local = zonedDateParts(now(), timeZone);
    let birthday;
    try {
      birthday = parseBirthdayDate(rawDate, { currentYear: local.year });
    } catch (error) {
      return error.message;
    }

    await db.upsertBirthday({
      chatId: message.chat.id,
      chatTitle: message.chat.title || null,
      user: message.from,
      ...birthday
    });

    return [
      `🎂 Запомнил: ${displayName(message.from)} — ${dateLabel({
        birth_day: birthday.day,
        birth_month: birthday.month,
        birth_year: birthday.year
      })}.`,
      'За день до праздника напомню в личке другим зарегистрированным участникам этого чата.',
      'Чтобы получать такие напоминания, каждый участник должен открыть меня в ЛС и нажать Start.'
    ].join('\n');
  };

  const remove = async (message) => {
    if (!db) return unavailableText;
    if (!['group', 'supergroup'].includes(message.chat?.type)) {
      return 'Удалить день рождения можно в том групповом чате, где он был зарегистрирован.';
    }
    const removed = await db.removeBirthday(message.chat.id, message.from?.id);
    return removed
      ? 'Удалил твою дату рождения из календаря этого чата.'
      : 'У тебя пока нет зарегистрированного дня рождения в этом чате.';
  };

  const list = async (message) => {
    if (!db) return unavailableText;
    if (!['group', 'supergroup'].includes(message.chat?.type)) {
      return 'Календарь дней рождения доступен в групповом чате.';
    }
    const birthdays = await db.listBirthdays(message.chat.id);
    if (!birthdays.length) return 'В календаре пока пусто. Начни с команды /birthday ДД.ММ.ГГГГ.';

    const lines = birthdays.map((birthday) =>
      `• ${dateLabel(birthday)} — ${displayName(birthday)}`
    );
    const text = ['🎂 Дни рождения этого чата:', '', ...lines].join('\n');
    return text.length <= 4000 ? text : `${text.slice(0, 3970)}\n…и ещё несколько праздников.`;
  };

  const sendClaimed = async ({ notification, sendMessage, text, extra }) => {
    const claimed = await db.claimBirthdayNotification(notification);
    if (!claimed) return false;

    try {
      await sendMessage(notification.recipientUserId, text, extra);
      return true;
    } catch (error) {
      if (!isPermanentTelegramError(error)) {
        await db.releaseBirthdayNotification(notification);
      }
      logger.error('birthday notification failed', {
        kind: notification.kind,
        chatId: String(notification.chatId),
        birthdayUserId: String(notification.birthdayUserId),
        recipientUserId: String(notification.recipientUserId),
        error: error?.message || String(error)
      });
      return false;
    }
  };

  const runDueNotifications = async ({ sendMessage, instant = now() } = {}) => {
    if (!db || !schedulerEnabled) return { sent: 0, skipped: 'disabled' };
    if (typeof sendMessage !== 'function') throw new Error('Birthday scheduler requires sendMessage.');

    const today = zonedDateParts(instant, timeZone);
    if (today.hour < checkHour) return { sent: 0, skipped: 'before_check_hour' };

    const tomorrow = addCalendarDays(today, 1);
    const todayDate = calendarDate(today);
    const tomorrowDate = calendarDate(tomorrow);
    let sent = 0;

    const todayBirthdays = await db.birthdaysForDate({
      month: today.month,
      day: today.day,
      includeLeapDay: today.month === 2 && today.day === 28 && !isLeapYear(today.year)
    });
    for (const birthday of todayBirthdays) {
      const delivered = await sendClaimed({
        notification: {
          chatId: birthday.chat_id,
          birthdayUserId: birthday.user_id,
          recipientUserId: birthday.chat_id,
          eventDate: todayDate,
          kind: 'congratulation'
        },
        sendMessage,
        text: congratulationText(birthday, today.year),
        extra: { parse_mode: 'HTML', disable_web_page_preview: true }
      });
      if (delivered) sent += 1;
    }

    const tomorrowBirthdays = await db.birthdaysForDate({
      month: tomorrow.month,
      day: tomorrow.day,
      includeLeapDay: tomorrow.month === 2 && tomorrow.day === 28 && !isLeapYear(tomorrow.year)
    });
    for (const birthday of tomorrowBirthdays) {
      const recipients = await db.birthdayReminderRecipients(birthday.chat_id, birthday.user_id);
      for (const recipient of recipients) {
        const delivered = await sendClaimed({
          notification: {
            chatId: birthday.chat_id,
            birthdayUserId: birthday.user_id,
            recipientUserId: recipient.user_id,
            eventDate: tomorrowDate,
            kind: 'reminder'
          },
          sendMessage,
          text: reminderText(birthday, tomorrow.year)
        });
        if (delivered) sent += 1;
      }
    }

    await db.deleteBirthdayNotificationsBefore?.(calendarDate(addCalendarDays(today, -400)));
    return { sent };
  };

  const startScheduler = ({ sendMessage } = {}) => {
    if (!db || !schedulerEnabled) return () => {};
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await runDueNotifications({ sendMessage });
      } catch (error) {
        logger.error('birthday scheduler failed', error);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(tick, checkIntervalMs);
    timer.unref?.();
    logger.log('birthday scheduler started', { timeZone, checkHour, checkIntervalMs });
    return () => clearInterval(timer);
  };

  return {
    enabled: Boolean(db),
    register,
    remove,
    list,
    runDueNotifications,
    startScheduler
  };
};

import { tokenizeText, wordCounts } from './tokenize.js';

const textFromMessage = (message) => message.text || message.caption || '';

const displayName = (user = {}) =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id || 'unknown');

const notConfigured = 'Аналитика еще не настроена. База данных где-то в клубе, походу.';

export const createAnalyticsService = ({ db } = {}) => {
  const ingestMessage = async (message) => {
    if (!db || !message?.from || !message?.chat) return;
    await db.upsertUser(message.chat.id, message.from);

    const words = tokenizeText(textFromMessage(message));
    if (!words.length) return;

    await db.incrementWordCounts({
      chatId: message.chat.id,
      userId: message.from.id,
      date: new Date((message.date || Math.floor(Date.now() / 1000)) * 1000),
      counts: wordCounts(words)
    });
  };

  const topWordsText = async (chatId, days = 14) => {
    if (!db) return notConfigured;
    const rows = await db.topWords(chatId, days, 5);
    if (!rows.length) return `Пока мало данных за ${days} дней. Пишите больше, а то статистика дохлая.`;

    const leaders = await db.topUsersForWords(chatId, rows.map((row) => row.word), days);
    const lines = rows.map((row, index) => {
      const leader = leaders.get(row.word);
      const leaderText = leader ? `\n   главный спамер этой красоты: ${displayName(leader)}, ${leader.total}` : '';
      return `${index + 1}. ${row.word} — ${row.total}${leaderText}`;
    });

    return [`Топ слов за ${days} дней, держитесь за жопы:`, '', ...lines].join('\n');
  };

  const ensureActiveCodeword = async (chatId) => {
    if (!db) return null;
    const current = await db.activeCodeword(chatId);
    if (current && new Date(current.expires_at).getTime() > Date.now()) return current;
    if (current) await db.expireCodeword(current.id);

    const candidates = await db.topWords(chatId, 14, 15);
    if (!candidates.length) return null;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)].word;
    return db.createCodeword(chatId, chosen);
  };

  const startCodewordText = async (chatId) => {
    if (!db) return notConfigured;
    const active = await ensureActiveCodeword(chatId);
    if (!active) return 'Пока мало слов для игры. Дайте мне накопить статистику, а то выбирать нечего, пиздец.';
    return 'Игра началась. Я выбрал кодовое слово из топ-15 за 14 дней. Ведите себя естественно, мои хорошие.';
  };

  const codewordStatusText = async (chatId) => {
    if (!db) return notConfigured;
    const active = await ensureActiveCodeword(chatId);
    if (!active) return 'Игры нет, и слов пока мало. Чат, просыпайся, ты че такой сухой.';
    const expiresAt = new Date(active.expires_at).getTime();
    const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000 / 60 / 60));
    return `Игра идет. Кодовое слово живет еще примерно ${hoursLeft}ч. Кто угадает — тот бусинка дня.`;
  };

  const codewordHintText = async (chatId) => {
    if (!db) return notConfigured;
    const active = await ensureActiveCodeword(chatId);
    if (!active) return 'Игры нет, и слов пока мало. Какую подсказку дать, воздух?';

    const leaders = await db.topUsersForWords(chatId, [active.word], 14);
    const leader = leaders.get(active.word);
    const leaderText = leader
      ? `\nЧаще всего это слово юзал(а): ${displayName(leader)}, ${leader.total} раз за 14 дней. Подозрительно, конечно.`
      : '';

    return `Подсказка, мои сладкие: в кодовом слове ${active.word.length} букв.${leaderText}`;
  };

  const stopCodewordText = async (chatId) => {
    if (!db) return notConfigured;
    const active = await db.activeCodeword(chatId);
    if (!active) return 'Активной игры нет. Останавливать нечего, шеф.';
    await db.expireCodeword(active.id);
    return 'Остановил игру. Всё, расходимся, шоу закрыто.';
  };

  const checkCodewordGuess = async (message) => {
    if (!db || !message?.chat || !message?.from) return null;
    const active = await db.activeCodeword(message.chat.id);
    if (!active) return null;

    if (new Date(active.expires_at).getTime() <= Date.now()) {
      await db.expireCodeword(active.id);
      return null;
    }

    const words = tokenizeText(textFromMessage(message));
    if (!words.includes(active.word)) return null;

    await db.guessCodeword(active.id, message.from.id, message.message_id);
    return `ЕБАТЬ. Кодовое слово было: "${active.word}"\n\nПобедил: ${displayName(message.from)}. Вот это заход, ну прям краш.`;
  };

  const pidorOfDayMessages = async (chatId, botId) => {
    if (!db) return [notConfigured];
    const user = await db.dailyPick(chatId, 'pidor', [botId].filter(Boolean));
    if (!user) return ['Некого выбирать. Пусть чат сначала хоть что-то напишет, а то кастинг пустой.'];

    const username = user.username ? ` (@${user.username})` : '';
    return [
      'ВНИМАНИЕ.',
      'ФЕДЕРАЛЬНЫЙ РОЗЫСК ПИДОРА ДНЯ ЗАПУЩЕН!',
      '4 - спутник запущен',
      '3 - архивы списков э**тейна подняты',
      '2 - очевидцы опрошены, все нервно молчат',
      '1 - вайб просканирован, улики липкие',
      `Сегодня ПИДОР дня: ${displayName(user)}${username}. Нихуя себе, вот это поворот. Поздравляем, вы заслужили этот титул.`
    ];
  };

  const resetPidorText = async (chatId) => {
    if (!db) return notConfigured;
    await db.resetDailyPick(chatId, 'pidor');
    return 'Сбросил выбор на сегодня. Можете крутить рулетку заново, хаос одобрен.';
  };

  const pidorHistoryText = async (chatId) => {
    if (!db) return notConfigured;
    const rows = await db.dailyPickHistory(chatId, 'pidor', 15);
    if (!rows.length) return 'История пустая. Еще никто не попадал в этот великолепный список.';

    return [
      'История выборов дня:',
      '',
      ...rows.map((row) => {
        const username = row.username ? ` (@${row.username})` : '';
        return `${row.day} — ${displayName(row)}${username}`;
      })
    ].join('\n');
  };

  return {
    ingestMessage,
    topWordsText,
    startCodewordText,
    codewordStatusText,
    codewordHintText,
    stopCodewordText,
    checkCodewordGuess,
    pidorOfDayMessages,
    resetPidorText,
    pidorHistoryText
  };
};

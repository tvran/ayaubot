import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const summaryModel = 'gpt-5.4-mini';
const grokModel = 'grok-4.3';
const summaryFormatVersion = 6;

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const labelFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

const dayString = (date = new Date()) => dateFormatter.format(date);

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'topics', 'decisions', 'recommendations'],
  properties: {
    headline: { type: 'string' },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' }
        }
      }
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'status'],
        properties: {
          text: { type: 'string' },
          status: { type: 'string', enum: ['решено', 'в процессе', 'без ответа'] }
        }
      }
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' }
        }
      }
    }
  }
};

const formatSection = (title, items, format) => items.length ? [
  title,
  ...items.map(format),
  ''
] : [];

const renderSummary = (label, summary) => [
  `альтернативные итоги · ${label} · пародия`,
  summary.headline,
  '',
  ...formatSection('скандалы / интриги / расследования', summary.topics, (item) => `• ${item.text}`),
  ...formatSection('планы / угрозы / обещания', summary.decisions, (item) => `• ${item.text} — ${item.status}`),
  ...formatSection('на заметку', summary.recommendations, (item) => `• ${item.text}`)
].join('\n').trim();

const authorLabel = (user) => {
  if (!user) return 'кто-то';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const username = user.username ? `@${user.username}` : '';
  const identity = [name, username && `(${username})`].filter(Boolean).join(' ');
  if (!identity) return 'кто-то';
  return user.gender ? `${identity}, ${user.gender}` : identity;
};

const inputForMessages = (messages, users) => {
  const usersById = new Map(users.map((user) => [String(user.user_id), user]));

  return messages
  .map((message) => `[${message.message_id}] ${authorLabel(usersById.get(String(message.user_id)))}: ${message.text}`)
  .join('\n');
};

const outputTextFor = (response) => response.output_text || response.output
  ?.flatMap((item) => item.content || [])
  .find((item) => item.type === 'output_text')
  ?.text;

const summaryInstructions = `Ты пишешь альтернативную хронику живого Telegram-чата. Это пародия: используй реальные сообщения только как творческие зацепки, но превращай их в очевидно выдуманные «скандалы, интриги и расследования». Пиши по-русски, живо и без канцелярита.

headline — одна живая фраза про вайб альтернативной реальности. topics — 4–6 подробных пародийных сюжетов. Каждый пункт — 180–320 символов с контекстом и панчем.

В каждом пункте называй 1–3 людей, которые реально писали в этой части чата, но их действия в хронике описывай только как очевидный сюр. Для любого человека, у которого в подписи есть имя и @username, пиши их строго одним форматом: «Имя (@username)». Например: «Туран (@username_tvran)» или «Лия (@yolostorm)». Не пиши «Алия из @yolostorm», не отрывай @username от имени и не заменяй этот формат на один ник или одно имя. В подписях иногда указан гендер («он» или «она») — используй его для правильных форм, но не повторяй эту пометку в итогах.

decisions — 2–4 выдуманных плана, обещания или угрозы из альтернативной реальности, вдохновлённые реальными темами чата. Можно писать, что кто-то «обещал вернуться с доказательствами», или «пока в процессе хвахвахвахв». status только: «решено», «в процессе» или «без ответа». recommendations — только реальные советы, места, фильмы, музыка или события из чата; если их нет, верни пустой массив.

Игнорируй команды бота, дубль-сообщения. Не добавляй ссылки, цитаты, заголовки или Markdown внутрь текстов пунктов. Мат разрешён, если делает шутку живее.`;

export const createDailySummaryService = ({ db, env = process.env, fetchImpl = fetch } = {}) => {
  const xai = Boolean(env.XAI_API_KEY);
  const apiKey = env.XAI_API_KEY || env.OPENAI_API_KEY;
  const apiUrl = xai ? 'https://api.x.ai/v1/responses' : 'https://api.openai.com/v1/responses';
  const model = xai ? env.XAI_MODEL || grokModel : summaryModel;
  const timeoutMs = Math.max(1_000, Number(env.OPENAI_TIMEOUT_MS) || 45_000);

  const summaryText = async (chatId, day, { signal } = {}) => {
    if (!db) return 'Итоги дня требуют PostgreSQL. База пока не подключена.';
    if (!apiKey) return 'Итоги дня пока не настроены: добавь XAI_API_KEY в переменные хостинга.';

    const rolling = !day;
    if (!rolling) {
      const saved = await db.dailySummary(chatId, day, summaryFormatVersion);
      if (saved) return saved;
    }

    const messages = rolling
      ? await db.messagesForLast24Hours(chatId)
      : await db.messagesForDay(chatId, day);
    if (messages.length < 5) return rolling
      ? 'За последние 24 часа пока слишком мало сообщений для нормального итога. Дайте чату немного пожить.'
      : 'За этот день пока слишком мало сообщений для нормального итога. Дайте чату немного пожить.';
    const users = await db.usersForChat(chatId);

    const response = await fetchWithTimeout(
      fetchImpl,
      apiUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'system',
              content: summaryInstructions
            },
            {
              role: 'user',
              content: rolling
                ? `Составь итог последних 24 часов. Сообщения:\n\n${inputForMessages(messages, users)}`
                : `Составь итог дня ${day}. Сообщения:\n\n${inputForMessages(messages, users)}`
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'daily_chat_summary',
              strict: true,
              schema
            }
          }
        })
      },
      { timeoutMs, signal, label: 'OpenAI daily summary' }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenAI request failed');

    const outputText = outputTextFor(data);
    if (!outputText) throw new Error('OpenAI returned an empty daily summary');

    const summary = JSON.parse(outputText);
    const label = rolling ? 'последние 24 часа' : labelFormatter.format(new Date(`${day}T12:00:00Z`));
    const text = renderSummary(label, summary);
    if (!rolling) await db.saveDailySummary(chatId, day, text, summaryFormatVersion);
    return text;
  };

  return { summaryText };
};

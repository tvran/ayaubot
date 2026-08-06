import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const summaryModel = 'gpt-5.4-mini';
const summaryFormatVersion = 3;

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

const renderSummary = (day, summary) => [
  `итоги дня · ${labelFormatter.format(new Date(`${day}T12:00:00Z`))}`,
  summary.headline,
  '',
  ...formatSection('что было', summary.topics, (item) => `• ${item.text}`),
  ...formatSection('договорились / висит', summary.decisions, (item) => `• ${item.text} — ${item.status}`),
  ...formatSection('на заметку', summary.recommendations, (item) => `• ${item.text}`)
].join('\n').trim();

const authorLabel = (user) => {
  if (!user) return 'кто-то';
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'кто-то';
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

export const createDailySummaryService = ({ db, env = process.env, fetchImpl = fetch } = {}) => {
  const apiKey = env.OPENAI_API_KEY;
  const timeoutMs = Math.max(1_000, Number(env.OPENAI_TIMEOUT_MS) || 45_000);

  const summaryText = async (chatId, day = dayString(), { signal } = {}) => {
    if (!db) return 'Итоги дня требуют PostgreSQL. База пока не подключена.';
    if (!apiKey) return 'Итоги дня пока не настроены: добавь OPENAI_API_KEY в переменные хостинга.';

    const saved = await db.dailySummary(chatId, day, summaryFormatVersion);
    if (saved) return saved;

    const messages = await db.messagesForDay(chatId, day);
    if (messages.length < 5) return 'За этот день пока слишком мало сообщений для нормального итога. Дайте чату немного пожить.';
    const users = await db.usersForChat(chatId);

    const response = await fetchWithTimeout(
      fetchImpl,
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: summaryModel,
          input: [
            {
              role: 'system',
              content: 'Ты собираешь итоги живого Telegram-чата как нормальный участник, а не корпоративный бот. Пиши по-русски коротко, естественно и без канцелярита. Используй только факты из сообщений; не додумывай решения, рекомендации, имена или события. Игнорируй команды бота, рекламу и бессмысленный флуд. headline — одна живая фраза про вайб дня. topics — максимум 3 действительно заметные темы. В каждом пункте называй 1–3 людей, которые реально вели разговор, если они есть в сообщениях: используй @username или имя ровно как указано перед двоеточием в строке сообщения. Не пиши обезличенное «обсуждали» или «один из участников», когда можно назвать человека. Не упоминай человека, если он ничего не внёс в тему. decisions — только конкретные договорённости или незакрытые вопросы. recommendations — только реальные советы, места, фильмы, музыка или полезные штуки; не превращай сюда шутки, сплетни и случайные реплики. Если раздел пустой — верни пустой массив. Текст каждого пункта до 180 символов. Не добавляй ссылки, цитаты, заголовки или markdown в текст пунктов.'
            },
            {
              role: 'user',
              content: `Составь итог дня ${day}. Сообщения:\n\n${inputForMessages(messages, users)}`
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
    const text = renderSummary(day, summary);
    await db.saveDailySummary(chatId, day, text, summaryFormatVersion);
    return text;
  };

  return { summaryText };
};

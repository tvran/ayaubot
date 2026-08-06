import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const summaryModel = 'gpt-5.4-mini';

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

const linkForMessage = (chatId, messageId) =>
  `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${messageId}`;

const messageLinks = (chatId, ids = []) => Array.from(new Set(ids))
  .filter(Number.isInteger)
  .slice(0, 3)
  .map((id) => `[в этом сообщении](${linkForMessage(chatId, id)})`)
  .join(', ');

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'topics', 'decisions', 'recommendations', 'links'],
  properties: {
    headline: { type: 'string' },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'messageIds'],
        properties: {
          text: { type: 'string' },
          messageIds: { type: 'array', items: { type: 'integer' } }
        }
      }
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'status', 'messageIds'],
        properties: {
          text: { type: 'string' },
          status: { type: 'string', enum: ['решено', 'в процессе', 'без ответа'] },
          messageIds: { type: 'array', items: { type: 'integer' } }
        }
      }
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'messageIds'],
        properties: {
          text: { type: 'string' },
          messageIds: { type: 'array', items: { type: 'integer' } }
        }
      }
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'messageIds'],
        properties: {
          text: { type: 'string' },
          messageIds: { type: 'array', items: { type: 'integer' } }
        }
      }
    }
  }
};

const formatSection = (chatId, items, format) => items.length ? items.map((item) => format(item, messageLinks(chatId, item.messageIds))).join('\n') : '—';

const renderSummary = (chatId, day, summary) => [
  `#итогидня ${labelFormatter.format(new Date(`${day}T12:00:00Z`))}`,
  summary.headline,
  '',
  'О чем говорили',
  formatSection(chatId, summary.topics, (item, links) => `- ${item.text}${links ? ` — ${links}` : ''}`),
  '',
  'Вопросы и что решили',
  formatSection(chatId, summary.decisions, (item, links) => `- ${item.text} (${item.status})${links ? ` — ${links}` : ''}`),
  '',
  'Что рекомендовали',
  formatSection(chatId, summary.recommendations, (item, links) => `- ${item.text}${links ? ` — ${links}` : ''}`),
  '',
  'Ссылки из чата',
  formatSection(chatId, summary.links, (item, links) => `- ${item.text}${links ? ` — ${links}` : ''}`)
].join('\n');

const inputForMessages = (messages) => messages
  .map((message) => `[${message.message_id}] ${message.text}`)
  .join('\n');

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

    const saved = await db.dailySummary(chatId, day);
    if (saved) return saved;

    const messages = await db.messagesForDay(chatId, day);
    if (messages.length < 5) return 'За этот день пока слишком мало сообщений для нормального итога. Дайте чату немного пожить.';

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
              content: 'Ты редактор итогов Telegram-чата. Пиши на русском кратко и живо. Используй только факты из сообщений. Не выдумывай решения, рекомендации, имена или ссылки. Для каждого пункта указывай реальные messageIds из входных сообщений. Игнорируй команды бота, рекламу и бессмысленный флуд. Дай максимум 4 темы, 5 решений, 3 рекомендации и 5 ссылок; текст каждого пункта — до 240 символов.'
            },
            {
              role: 'user',
              content: `Составь итог дня ${day}. Сообщения:\n\n${inputForMessages(messages)}`
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
    const text = renderSummary(chatId, day, summary);
    await db.saveDailySummary(chatId, day, text);
    return text;
  };

  return { summaryText };
};

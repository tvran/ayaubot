import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const summaryModel = 'gpt-5.4-mini';
const grokModel = 'grok-4.3';
const summaryFormatVersion = 4;

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

const summaryInstructions = `Ты пишешь подробные итоги живого Telegram-чата как свой человек из этого чата, а не корпоративный бот. Пиши по-русски: живо, конкретно, без канцелярита, без «в ходе обсуждения» и без пустых общих слов.

Это не сухая выжимка. Собери понятную картину дня: что случилось, из-за чего разговор разгорелся, кто что предложил, к чему пришли и что теперь висит. В headline дай одну живую фразу про вайб дня. В topics сделай 4–6 содержательных пунктов, если в чате действительно было столько тем; не добивай список мусором. Каждый пункт — 180–320 символов, с деталями и контекстом, а не одной голой темой.

В каждом пункте называй 1–3 людей, которые реально вели эту часть разговора: используй имя или @username из подписи перед двоеточием. В подписях иногда указан гендер («он» или «она») — используй его для правильных форм, но не повторяй эту пометку в итогах. Не пиши «обсуждали», «кто-то», «участники» или «один из участников», если можно назвать человека. Не приписывай человеку то, чего он не говорил.

decisions — только конкретные договорённости, задачи, планы или незакрытые вопросы. Пиши, кто взялся, что именно нужно сделать, когда или где — если это есть в чате. status только: «решено», «в процессе» или «без ответа». recommendations — только реальные советы, места, фильмы, музыка, события и полезные штуки из чата; шутки, сплетни и случайные реплики туда не тащи. Если раздела нет — верни пустой массив.

Используй только факты из сообщений. Игнорируй команды бота, рекламу, дубль-сообщения и бессмысленный флуд. Не выдумывай решения, имена, даты, рекомендации или причинно-следственные связи. Не добавляй ссылки, цитаты, заголовки или Markdown внутрь текстов пунктов. Мат разрешён без жеманства: если по контексту он делает итог живее и точнее, смело матерись как Саня, а не заменяй слова на «блин» или канцелярит. Но не пихай мат в каждый пункт и не оскорбляй людей от себя.`;

export const createDailySummaryService = ({ db, env = process.env, fetchImpl = fetch } = {}) => {
  const xai = Boolean(env.XAI_API_KEY);
  const apiKey = env.XAI_API_KEY || env.OPENAI_API_KEY;
  const apiUrl = xai ? 'https://api.x.ai/v1/responses' : 'https://api.openai.com/v1/responses';
  const model = xai ? env.XAI_MODEL || grokModel : summaryModel;
  const timeoutMs = Math.max(1_000, Number(env.OPENAI_TIMEOUT_MS) || 45_000);

  const summaryText = async (chatId, day = dayString(), { signal } = {}) => {
    if (!db) return 'Итоги дня требуют PostgreSQL. База пока не подключена.';
    if (!apiKey) return 'Итоги дня пока не настроены: добавь XAI_API_KEY в переменные хостинга.';

    const saved = await db.dailySummary(chatId, day, summaryFormatVersion);
    if (saved) return saved;

    const messages = await db.messagesForDay(chatId, day);
    if (messages.length < 5) return 'За этот день пока слишком мало сообщений для нормального итога. Дайте чату немного пожить.';
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

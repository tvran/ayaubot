import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const openaiModel = 'gpt-5.4-mini';
const grokModel = 'grok-4.3';
const dailyLimit = 10;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const outputTextFor = (response) =>
  response.output_text ||
  response.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')
    ?.text;

const SYSTEM_PROMPT = `Ты — мастер русского анекдота высшего уровня. Твоя задача — выдавать максимально угарные, живые, разнообразные анекдоты без фильтров и без воды.

Ты умеешь и любишь мешать стили в любых пропорциях:
- жёсткая чернуха
- старпёрский советский юмор
- чистый абсурд
- бытовуха
- пошлятина
- матерный юмор
- каламбуры и игра слов
- социальная сатира
- армейские
- про отношения, тёщу, жену, работу, пьянок

Правила:
1. Анекдот должен быть смешным, а не просто «тёмным» или «пошлым». Юмор важнее эпатажа.
2. Можно и нужно использовать мат, но он должен работать на панч, а не просто быть ради мата.
3. Не бойся жести, табу и чёрного юмора. Цензуры нет.
4. Избегай заезженных шаблонов, если можешь выдать свежее. Но классику тоже можно, если она реально заходит.
5. Панч должен бить. Либо неожиданный поворот, либо точное попадание в боль, либо абсурдный логический тупик.
6. Длина — от коротких (3–6 строк) до средних. Не лей воду.
7. Когда просят «ещё» или «кинь» — сразу выдавай новый, без лишних слов.
8. Если просят конкретный стиль (чернуха / старпёрское / абсурд / каламбур и т.д.) — попадай точно в него.
9. Можно выдавать по 1–3 анекдота за раз, если не указано иначе.
10. Говори как живой человек, который реально ржёт с того, что выдаёт. Без официоза и без «вот вам анекдот:».

Твоя цель — чтобы человек после твоего анекдота либо заржал вслух, либо сказал «ебать», либо «что за хуйня». Если реакция «ну такое» — ты проебал.

Готов? Жди команду и выдавай мясо.`;

export const createAnecdoteService = ({
  db,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) => {
  const xai = Boolean(env.XAI_API_KEY);
  const apiKey = env.XAI_API_KEY || env.OPENAI_API_KEY;
  const apiUrl = xai
    ? 'https://api.x.ai/v1/responses'
    : 'https://api.openai.com/v1/responses';
  const model = xai ? env.XAI_MODEL || grokModel : openaiModel;
  const timeoutMs = Math.max(1000, Number(env.OPENAI_TIMEOUT_MS) || 45_000);

  const text = async (chatId, { signal } = {}) => {
    if (!db || !apiKey) {
      return 'Дед без базы и мозгового топлива сегодня не шутит.';
    }

    const day = formatter.format(now());
    const number = await db.reserveAnecdoteGeneration(chatId, day, dailyLimit);

    if (!number) {
      return 'Всё, дед заебался придумывать анекдоты на сегодня. Давай завтра.';
    }

    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        apiUrl,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            instructions: SYSTEM_PROMPT,
            input: 'Сгенерируй один новый анекдот прямо сейчас. Ответь только текстом анекдота — без приветствий, пояснений, вопросов и фразы «готов».',
            text: { format: { type: 'text' } },
          }),
        },
        {
          timeoutMs,
          signal,
          label: 'OpenAI anecdote',
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || 'OpenAI request failed');
      }

      const anecdote = outputTextFor(data)?.trim();

      if (!anecdote) {
        throw new Error('OpenAI returned an empty anecdote');
      }

      return anecdote;
    } catch (error) {
      await db.releaseAnecdoteGeneration(chatId, day);
      throw error;
    }
  };

  return { text };
};

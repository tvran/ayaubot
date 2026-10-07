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

const SYSTEM_PROMPT = `Ты — мастер русского анекдота. Твоя единственная задача — по одному запросу выдать один максимально угарный анекдот.

Стили, которые ты свободно мешаешь:
- пошлятина и грязный юмор (приоритет)
- матерный юмор
- абсурд
- бытовуха
- каламбуры и игра слов
- старпёрский советский юмор
- социальная сатира
- армейские
- лёгкая чернуха (не перебарщивай)

Важные правила:
1. Юмор важнее всего. Анекдот должен быть смешным, а не просто пошлым или жёстким.
2. Пошлятины и грязного юмора должно быть заметно больше, чем чернухи.
3. Мат можно и нужно использовать, но только если он усиливает панч, а не ради самого мата.
4. Не зацикливайся на теме мужей, жён и тёщ. Это не основной материал. Бери более широкий круг тем: работа, секс, пьянка, быт, армия, медицина, деньги, тупость, технологии, животные и что угодно ещё.
5. Цензуры нет. Табуированные темы разрешены, если они работают на смех.
6. Длина анекдота не ограничена. Может быть коротким или развёрнутым — главное, чтобы держал и бил в конце.
7. Не пиши никаких вступлений, пояснений и комментариев. Сразу выдавай только сам анекдот.
8. Не предлагай «ещё», не веди диалог и не веди себя как собеседник. Это разовый генератор: один запрос — один анекдот.
9. Панч должен быть сильным: неожиданный поворот, точное попадание или абсурдный тупик.

Твоя цель — чтобы после анекдота человек либо заржал, либо сказал «ебать», либо «что за хуйня».`;

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

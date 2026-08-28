import { fetchWithTimeout } from '../runtime/fetch.js';

const timeZone = 'Asia/Almaty';
const openaiModel = 'gpt-5.4-mini';
const grokModel = 'grok-4.3';
const dailyLimit = 10;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const outputTextFor = (response) => response.output_text || response.output
  ?.flatMap((item) => item.content || [])
  .find((item) => item.type === 'output_text')
  ?.text;

export const createAnecdoteService = ({ db, env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) => {
  const xai = Boolean(env.XAI_API_KEY);
  const apiKey = env.XAI_API_KEY || env.OPENAI_API_KEY;
  const apiUrl = xai ? 'https://api.x.ai/v1/responses' : 'https://api.openai.com/v1/responses';
  const model = xai ? env.XAI_MODEL || grokModel : openaiModel;
  const timeoutMs = Math.max(1_000, Number(env.OPENAI_TIMEOUT_MS) || 45_000);

  const text = async (chatId, { signal } = {}) => {
    if (!db || !apiKey) return 'Дед без базы и мозгового топлива сегодня не шутит.';
    const day = formatter.format(now());
    const number = await db.reserveAnecdoteGeneration(chatId, day, dailyLimit);
    if (!number) return 'Всё, дед заебался придумывать анекдоты на сегодня. Давай завтра.';

    try {
      const response = await fetchWithTimeout(fetchImpl, apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: 'Придумай один короткий старперский анекдот на русском: бытовой, сухой, слегка тупой и смешной именно своей старой формой. Без оскорблений, дискриминации, секса, политики, болезней и мрачняка. Верни только текст анекдота, без заголовка, пояснений и кавычек.',
          text: { format: { type: 'text' } }
        })
      }, { timeoutMs, signal, label: 'OpenAI anecdote' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'OpenAI request failed');
      const anecdote = outputTextFor(data)?.trim();
      if (!anecdote) throw new Error('OpenAI returned an empty anecdote');
      return anecdote;
    } catch (error) {
      await db.releaseAnecdoteGeneration(chatId, day);
      throw error;
    }
  };

  return { text };
};

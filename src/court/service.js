import { fetchWithTimeout } from '../runtime/fetch.js';

const fallbackQuestions = [
  'Кто сегодня тайно живёт в шкафу офиса?',
  'Кому доверить охранять один вареник до утра?',
  'Кто начнёт спор с автоматом по продаже воды и проиграет морально?',
  'Кто лучше всех переживёт апокалипсис с пакетом и чужим пауэрбанком?',
  'Кого отправляем договариваться с луной о переносе понедельника?',
  'Кто умеет испортить тишину одним «ребят»?',
  'Кому вручить ключи от подвала, которого у нас нет?',
  'Кто вообще-то гусь, но тщательно это скрывает?'
];
const bankRefreshMs = 14 * 24 * 60 * 60 * 1000;
const closeAfterMs = 15 * 60 * 1000;
const votesToClose = 6;

const label = (user) => user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'кто-то';
const keyboard = (session) => ({ inline_keyboard: session.options.map((option) => ([{
  text: `${option.label} — ${option.votes || 0}`,
  callback_data: `court:${session.id}:${option.user_id}`
}])) });
const text = (session, closed = false) => [
  closed ? 'суд дня вынес вердикт' : 'суд дня открыт',
  '',
  session.question,
  '',
  closed ? `голосов: ${session.total_votes}` : `голосование закроется на 6-м голосе или через 15 минут`
].join('\n');

export const createCourtService = ({ db, env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) => {
  const pool = db?.pool;
  const apiKey = env.OPENAI_API_KEY;

  const loadBank = async () => {
    const current = await pool.query('select questions, updated_at from court_question_banks where id = true');
    const row = current.rows[0];
    if (row && now() - new Date(row.updated_at) < bankRefreshMs) return row.questions;
    if (!apiKey) return row?.questions || fallbackQuestions;
    const response = await fetchWithTimeout(fetchImpl, 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: 'Придумай 30 коротких абсурдных вопросов для голосования в русском дружеском чате. Без офисной и тех-бро тем, без оскорблений. Верни только JSON-массив строк.', text: { format: { type: 'json_schema', name: 'court_questions', strict: true, schema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 20, maxItems: 40, items: { type: 'string' } } } } } } })
    }, { timeoutMs: 30_000, label: 'OpenAI court question bank' });
    const data = await response.json();
    const output = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    const questions = response.ok ? JSON.parse(output).questions : fallbackQuestions;
    await pool.query('insert into court_question_banks (id, questions) values (true, $1::jsonb) on conflict (id) do update set questions = excluded.questions, updated_at = now()', [JSON.stringify(questions)]);
    return questions;
  };

  const session = async (id) => {
    const result = await pool.query(`select s.*, coalesce(json_agg(json_build_object('user_id', o.user_id, 'label', o.label, 'votes', o.votes) order by o.user_id) filter (where o.user_id is not null), '[]') as options, count(v.voter_id)::int as total_votes from court_sessions s left join court_options o on o.session_id=s.id left join court_votes v on v.session_id=s.id where s.id=$1 group by s.id`, [id]);
    return result.rows[0] || null;
  };

  const start = async (chatId, sendMessage) => {
    const today = now().toISOString().slice(0, 10);
    const existing = await pool.query('select id from court_sessions where chat_id=$1 and day=$2::date', [chatId, today]);
    if (existing.rows[0]) return { existing: await session(existing.rows[0].id) };
    const candidates = await pool.query(`select u.user_id, u.first_name, u.last_name, u.username from users u join chat_messages m on m.chat_id=u.chat_id and m.user_id=u.user_id where u.chat_id=$1 and m.sent_at > now() - interval '7 days' group by u.user_id, u.first_name, u.last_name, u.username order by random() limit 5`, [chatId]);
    if (candidates.rows.length < 2) return { error: 'Нужно хотя бы два живых человека в чате за последнюю неделю.' };
    const questions = await loadBank();
    const question = questions[Math.floor(Math.random() * questions.length)];
    const created = await pool.query(`insert into court_sessions (chat_id, day, question, closes_at) values ($1, $2::date, $3, now() + interval '15 minutes') returning id`, [chatId, today, question]);
    const id = created.rows[0].id;
    await Promise.all(candidates.rows.map((user) => pool.query('insert into court_options (session_id, user_id, label) values ($1, $2, $3)', [id, user.user_id, label(user)])));
    const open = await session(id);
    const message = await sendMessage(chatId, text(open), { reply_markup: keyboard(open) });
    await pool.query('update court_sessions set message_id=$2 where id=$1', [id, message.message_id]);
    return { session: open };
  };

  const vote = async ({ id, voterId, optionId }) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const state = await client.query('select status from court_sessions where id=$1 for update', [id]);
      if (state.rows[0]?.status !== 'open') return { closed: true };
      const inserted = await client.query('insert into court_votes (session_id, voter_id, option_user_id) values ($1,$2,$3) on conflict do nothing returning voter_id', [id, voterId, optionId]);
      if (!inserted.rowCount) return { duplicate: true };
      await client.query('update court_options set votes=votes+1 where session_id=$1 and user_id=$2', [id, optionId]);
      const count = await client.query('select count(*)::int as count from court_votes where session_id=$1', [id]);
      const closed = count.rows[0].count >= votesToClose;
      if (closed) await client.query("update court_sessions set status='closed' where id=$1", [id]);
      await client.query('commit');
      return { closed };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  };

  const closeExpired = async (editMessage) => {
    const expired = await pool.query("update court_sessions set status='closed' where status='open' and closes_at <= now() returning id");
    for (const row of expired.rows) { const item = await session(row.id); await editMessage(item.chat_id, item.message_id, text(item, true)); }
  };

  return { start, session, vote, closeExpired, refreshQuestionBank: loadBank, text, keyboard };
};

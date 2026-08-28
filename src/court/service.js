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
const closeAfterMs = 15 * 60 * 1000;
const votesToClose = 6;

const label = (user) => {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  if (name && user.username) return `${name} (@${user.username})`;
  return name || (user.username ? `@${user.username}` : 'кто-то');
};
const resultText = (session) => {
  const highest = Math.max(0, ...session.options.map((option) => Number(option.votes)));
  const winners = highest
    ? session.options.filter((option) => Number(option.votes) === highest).map((option) => option.label).join(' и ')
    : 'никто';
  return [
    'суд дня вынес вердикт',
    '',
    session.question,
    '',
    highest ? `вердикт: ${winners} — ${highest}` : 'вердикт: суду не за что зацепиться',
    `голосов: ${session.total_votes}`,
    '',
    ...session.options.map((option) => `• ${option.label} — ${option.votes}`)
  ].join('\n');
};

export const createCourtService = ({ db, env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) => {
  const pool = db?.pool;
  const apiKey = env.OPENAI_API_KEY;

  const loadBank = async () => {
    const current = await pool.query('select questions from court_question_banks where id = true');
    const row = current.rows[0];
    if (row) return row.questions;
    if (!apiKey) return row?.questions || fallbackQuestions;
    const response = await fetchWithTimeout(fetchImpl, 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: 'Придумай 30 вопросов для голосования в русском дружеском чате. Каждый — короткий, но понятный абсурдный сюжет на 1–2 предложения: ситуация и затем вопрос, кто из чата в ней отличится. Никаких внутренних мемов, имён, офиса, тех-бро, детсада, милоты, канцелярита и оскорблений. Нужен живой взрослый сюр: нелепые правила города, аэропорты, лифты, странные квесты, говорящие животные, бытовая катастрофа. Верни только JSON-массив строк.', text: { format: { type: 'json_schema', name: 'court_questions', strict: true, schema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 20, maxItems: 40, items: { type: 'string' } } } } } } })
    }, { timeoutMs: 30_000, label: 'OpenAI court question bank' });
    const data = await response.json();
    const output = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    const questions = response.ok ? JSON.parse(output).questions : fallbackQuestions;
    await pool.query('insert into court_question_banks (id, questions) values (true, $1::jsonb) on conflict (id) do update set questions = excluded.questions, updated_at = now()', [JSON.stringify(questions)]);
    return questions;
  };

  const session = async (id, client = pool) => {
    const result = await client.query(`select s.*, coalesce((select json_agg(json_build_object('user_id', o.user_id, 'label', o.label, 'votes', o.votes) order by o.user_id) from court_options o where o.session_id=s.id), '[]') as options, (select count(*)::int from court_votes v where v.session_id=s.id) as total_votes from court_sessions s where s.id=$1`, [id]);
    return result.rows[0] || null;
  };

  const start = async (chatId, sendPoll, { reroll = false, commandMessageId } = {}) => {
    const today = now().toISOString().slice(0, 10);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [String(chatId), today]);
      const duplicate = commandMessageId == null ? null : await client.query('select id from court_sessions where chat_id=$1 and command_message_id=$2', [chatId, commandMessageId]);
      if (duplicate?.rows[0]) { await client.query('commit'); return { duplicate: true }; }
      const existing = await client.query('select id from court_sessions where chat_id=$1 and day=$2::date order by round desc limit 1 for update', [chatId, today]);
      const latest = existing.rows[0] ? await session(existing.rows[0].id, client) : null;
      if (latest?.status === 'open' && !reroll) { await client.query('commit'); return { existing: latest }; }
      const replaced = latest?.status === 'open' ? latest : null;
      if (replaced) await client.query("update court_sessions set status='closed' where id=$1", [replaced.id]);
      const candidates = await client.query(`select u.user_id, u.first_name, u.last_name, u.username from users u join chat_messages m on m.chat_id=u.chat_id and m.user_id=u.user_id where u.chat_id=$1 and m.sent_at > now() - interval '7 days' group by u.user_id, u.first_name, u.last_name, u.username order by random() limit 5`, [chatId]);
      if (candidates.rows.length < 2) { await client.query('commit'); return { error: 'Нужно хотя бы два живых человека в чате за последнюю неделю.' }; }
      const questions = await loadBank();
      const question = questions[Math.floor(Math.random() * questions.length)];
      const created = await client.query(`insert into court_sessions (chat_id, day, round, question, closes_at, command_message_id) values ($1, $2::date, $3, $4, now() + interval '15 minutes', $5) returning id`, [chatId, today, (latest?.round || 0) + 1, question, commandMessageId || null]);
      const id = created.rows[0].id;
      await Promise.all(candidates.rows.map((user) => client.query('insert into court_options (session_id, user_id, label) values ($1, $2, $3)', [id, user.user_id, label(user)])));
      const open = await session(id, client);
      const message = await sendPoll(chatId, open.question, open.options.map((option) => option.label));
      await client.query('update court_sessions set message_id=$2, poll_id=$3 where id=$1', [id, message.message_id, message.poll.id]);
      await client.query('commit');
      return { session: open, replaced };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  };

  const vote = async ({ id, voterId, optionId }) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const state = await client.query('select status from court_sessions where id=$1 for update', [id]);
      if (state.rows[0]?.status !== 'open') { await client.query('commit'); return { closed: true }; }
      const previous = await client.query('select option_user_id from court_votes where session_id=$1 and voter_id=$2 for update', [id, voterId]);
      if (optionId == null) {
        if (!previous.rowCount) { await client.query('commit'); return { duplicate: true }; }
        await client.query('update court_options set votes=greatest(0, votes-1) where session_id=$1 and user_id=$2', [id, previous.rows[0].option_user_id]);
        await client.query('delete from court_votes where session_id=$1 and voter_id=$2', [id, voterId]);
        await client.query('commit');
        return { removed: true };
      }
      const target = await client.query('select user_id from court_options where session_id=$1 and user_id=$2 for update', [id, optionId]);
      if (!target.rowCount) { await client.query('commit'); return { ignored: true }; }
      if (previous.rows[0]?.option_user_id === optionId) { await client.query('commit'); return { duplicate: true }; }
      if (previous.rowCount) {
        await client.query('update court_options set votes=greatest(0, votes-1) where session_id=$1 and user_id=$2', [id, previous.rows[0].option_user_id]);
        await client.query('update court_votes set option_user_id=$3, created_at=now() where session_id=$1 and voter_id=$2', [id, voterId, optionId]);
      } else {
        await client.query('insert into court_votes (session_id, voter_id, option_user_id) values ($1,$2,$3)', [id, voterId, optionId]);
      }
      await client.query('update court_options set votes=votes+1 where session_id=$1 and user_id=$2', [id, optionId]);
      const count = await client.query('select count(*)::int as count from court_votes where session_id=$1', [id]);
      const closed = count.rows[0].count >= votesToClose;
      if (closed) await client.query("update court_sessions set status='closed' where id=$1", [id]);
      await client.query('commit');
      return { closed, changed: previous.rowCount > 0 };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  };

  const votePoll = async ({ pollId, voterId, optionIds }) => {
    const found = await pool.query('select id from court_sessions where poll_id=$1', [pollId]);
    if (!found.rows[0] || optionIds.length > 1) return { ignored: true };
    const item = await session(found.rows[0].id);
    const result = await vote({ id: item.id, voterId, optionId: item.options[optionIds[0]]?.user_id });
    return { ...result, session: await session(item.id) };
  };

  const closeExpired = async (finish) => {
    const expired = await pool.query("update court_sessions set status='closed' where status='open' and closes_at <= now() returning id");
    for (const row of expired.rows) { const item = await session(row.id); await finish(item); }
  };

  return { start, session, votePoll, closeExpired, refreshQuestionBank: loadBank, resultText };
};

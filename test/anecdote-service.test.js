import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnecdoteService } from '../src/anecdote/service.js';

test('generates an anecdote and reserves a daily slot', async () => {
  const reservations = [];
  let request;
  const service = createAnecdoteService({
    db: {
      reserveAnecdoteGeneration: async (...args) => { reservations.push(args); return 1; },
      releaseAnecdoteGeneration: async () => assert.fail('must not release a successful generation')
    },
    env: { XAI_API_KEY: 'test-key' },
    now: () => new Date('2026-08-28T08:00:00Z'),
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Встретились два пенсионера. Один забыл зачем.' }] }] }), { status: 200 });
    }
  });

  assert.equal(await service.text(-1), 'Встретились два пенсионера. Один забыл зачем.');
  assert.deepEqual(reservations, [[-1, '2026-08-28', 10]]);
  assert.equal(request.url, 'https://api.x.ai/v1/responses');
  assert.equal(request.body.model, 'grok-4.3');
  assert.match(request.body.instructions, /старпёрский советский юмор/);
  assert.match(request.body.input, /Сгенерируй один новый анекдот/);
});

test('stops after ten anecdotes', async () => {
  const service = createAnecdoteService({
    db: { reserveAnecdoteGeneration: async () => null },
    env: { OPENAI_API_KEY: 'test-key' }
  });

  assert.equal(await service.text(-1), 'Всё, дед заебался придумывать анекдоты на сегодня. Давай завтра.');
});

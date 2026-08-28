import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailySummaryService } from '../src/summary/service.js';

test('reads JSON output from the Responses API output content', async () => {
  let saved;
  let request;
  const service = createDailySummaryService({
    db: {
      async dailySummary() { return null; },
      async messagesForDay() {
        return Array.from({ length: 5 }, (_, index) => ({
          message_id: index + 1,
          user_id: 42,
          text: `Сообщение ${index + 1}`
        }));
      },
      async usersForChat() {
        return [{ user_id: 42, first_name: 'Саня', username: 'sanya' }];
      },
      async saveDailySummary(chatId, day, text) { saved = { chatId, day, text }; }
    },
    env: { XAI_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            headline: 'Короткий итог',
            topics: [{ text: '@sanya устроил короткий итог' }],
            decisions: [],
            recommendations: []
          })
        }]
      }]
      }), { status: 200 });
    }
  });

  const text = await service.summaryText(-100123, '2026-08-06');

  assert.match(text, /Короткий итог/);
  assert.match(text, /@sanya/);
  assert.doesNotMatch(text, /t\.me\/c/);
  assert.doesNotMatch(text, /Ссылки из чата/);
  assert.equal(saved.chatId, -100123);
  assert.equal(request.url, 'https://api.x.ai/v1/responses');
  assert.equal(request.body.model, 'grok-4.3');
});

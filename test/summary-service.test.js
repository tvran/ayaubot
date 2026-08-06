import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailySummaryService } from '../src/summary/service.js';

test('reads JSON output from the Responses API output content', async () => {
  let saved;
  const service = createDailySummaryService({
    db: {
      async dailySummary() { return null; },
      async messagesForDay() {
        return Array.from({ length: 5 }, (_, index) => ({
          message_id: index + 1,
          text: `Сообщение ${index + 1}`
        }));
      },
      async saveDailySummary(chatId, day, text) { saved = { chatId, day, text }; }
    },
    env: { OPENAI_API_KEY: 'test-key' },
    fetchImpl: async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            headline: 'Короткий итог',
            topics: [],
            decisions: [],
            recommendations: [],
            links: []
          })
        }]
      }]
    }), { status: 200 })
  });

  const text = await service.summaryText(-100123, '2026-08-06');

  assert.match(text, /Короткий итог/);
  assert.equal(saved.chatId, -100123);
});

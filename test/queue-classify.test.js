import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyUpdateLane, updateQueueRecord } from '../src/queue/classify.js';

const update = (text, extra = {}) => ({
  update_id: 123,
  message: {
    message_id: 10,
    chat: { id: -1001 },
    from: { id: 7 },
    text,
    ...extra
  }
});

test('classifies rendering, summary and external video updates as heavy', () => {
  assert.equal(classifyUpdateLane(update('/demotivation текст')), 'heavy');
  assert.equal(classifyUpdateLane(update('/q 3')), 'heavy');
  assert.equal(classifyUpdateLane(update('#итогидня')), 'heavy');
  assert.equal(classifyUpdateLane(update('https://www.instagram.com/reel/example/')), 'heavy');
  assert.equal(classifyUpdateLane(update('/help')), 'default');
});

test('builds a durable queue record only for supported message updates', () => {
  assert.deepEqual(updateQueueRecord(update('/help')), {
    updateId: 123,
    chatId: -1001,
    lane: 'default',
    payload: update('/help')
  });
  assert.equal(updateQueueRecord({ update_id: 124, callback_query: {} }), null);
});

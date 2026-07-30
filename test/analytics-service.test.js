import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalyticsService } from '../src/analytics/service.js';

test('rememberParticipants stores human authors and joined users but skips bots', async () => {
  const upserts = [];
  const db = {
    upsertUser: async (chatId, user) => upserts.push([chatId, user.id])
  };
  const analytics = createAnalyticsService({ db });

  await analytics.rememberParticipants({
    chat: { id: -100 },
    from: { id: 1, first_name: 'Alice' },
    new_chat_members: [
      { id: 2, first_name: 'Bob' },
      { id: 3, first_name: 'Bot', is_bot: true },
      { id: 1, first_name: 'Alice' }
    ]
  });

  assert.deepEqual(upserts, [[-100, 1], [-100, 2]]);
});

test('knownUsers delegates to the database and reports unavailable storage', async () => {
  const rows = [{ user_id: 1, first_name: 'Alice' }];
  const analytics = createAnalyticsService({ db: { usersForChat: async (chatId) => {
    assert.equal(chatId, -100);
    return rows;
  } } });

  assert.equal(await createAnalyticsService().knownUsers(-100), null);
  assert.equal(await analytics.knownUsers(-100), rows);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMentionMessages,
  findMentionableUsers,
  isCurrentHumanMember
} from '../src/bot/mentions.js';

test('isCurrentHumanMember excludes bots and former members', () => {
  assert.equal(isCurrentHumanMember({ status: 'member', user: { id: 1, is_bot: false } }), true);
  assert.equal(isCurrentHumanMember({ status: 'administrator', user: { id: 2, is_bot: true } }), false);
  assert.equal(isCurrentHumanMember({ status: 'left', user: { id: 3, is_bot: false } }), false);
  assert.equal(isCurrentHumanMember({ status: 'restricted', is_member: false, user: { id: 4 } }), false);
  assert.equal(isCurrentHumanMember({ status: 'restricted', is_member: true, user: { id: 4 } }), true);
});

test('buildMentionMessages creates safe Telegram entities and removes duplicates', () => {
  const messages = buildMentionMessages([
    { id: 10, first_name: 'Алиса <3' },
    { id: 20, username: 'bob' },
    { id: 10, first_name: 'Дубликат' },
    { id: 30, first_name: 'Robot', is_bot: true }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '📣 Все сюда:\nАлиса <3 · @bob');
  assert.deepEqual(messages[0].entities, [
    {
      type: 'text_link',
      offset: '📣 Все сюда:\n'.length,
      length: 'Алиса <3'.length,
      url: 'tg://user?id=10'
    },
    {
      type: 'text_link',
      offset: '📣 Все сюда:\nАлиса <3 · '.length,
      length: '@bob'.length,
      url: 'tg://user?id=20'
    }
  ]);
});

test('buildMentionMessages splits a long list without breaking entity offsets', () => {
  const messages = buildMentionMessages([
    { id: 1, first_name: 'Alice' },
    { id: 2, first_name: 'Bob' },
    { id: 3, first_name: 'Carol' }
  ], { maxLength: 24, header: 'Call: ' });

  assert.deepEqual(messages.map((message) => message.text), ['Call: Alice · Bob', 'Call: Carol']);
  for (const message of messages) {
    assert.ok(message.text.length <= 24);
    for (const entity of message.entities) {
      assert.ok(message.text.slice(entity.offset, entity.offset + entity.length));
    }
  }
});

test('findMentionableUsers keeps current humans and verifies candidates in batches', async () => {
  const calls = [];
  const errors = [];
  const members = {
    1: { status: 'member', user: { id: 1, first_name: 'Alice', is_bot: false } },
    2: { status: 'member', user: { id: 2, first_name: 'Robot', is_bot: true } },
    3: { status: 'left', user: { id: 3, first_name: 'Former', is_bot: false } },
    4: { status: 'restricted', is_member: true, user: { id: 4, first_name: 'Bob', is_bot: false } }
  };
  const api = async (method, payload) => {
    calls.push([method, payload]);
    if (method === 'getChatAdministrators') {
      return [
        { status: 'administrator', user: { id: 5, first_name: 'Admin', is_bot: false } },
        { status: 'administrator', user: { id: 6, first_name: 'AdminBot', is_bot: true } }
      ];
    }
    if (payload.user_id === 7) throw new Error('unavailable');
    return members[payload.user_id];
  };

  const users = await findMentionableUsers({
    api,
    chatId: -100,
    knownUsers: [1, 2, 3, 4, 5, 7].map((id) => ({ id })),
    concurrency: 2,
    onError: (...args) => errors.push(args)
  });

  assert.deepEqual(users.map((user) => user.id), [5, 1, 4]);
  assert.deepEqual(
    calls.filter(([method]) => method === 'getChatMember').map(([, payload]) => payload.user_id),
    [1, 2, 3, 4, 7]
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'getChatMember');
});

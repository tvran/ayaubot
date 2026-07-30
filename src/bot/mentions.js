const defaultHeader = '📣 Все сюда:\n';

const displayName = (user = {}) => {
  const fullName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return `Пользователь ${user.id}`;
};

const mentionEntity = (user, offset, length) => ({
  type: 'text_link',
  offset,
  length,
  url: `tg://user?id=${user.id}`
});

export const isCurrentHumanMember = (member) => {
  if (!member?.user || member.user.is_bot) return false;
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  return member.status === 'restricted' && member.is_member === true;
};

export const findMentionableUsers = async ({
  api,
  chatId,
  knownUsers,
  concurrency = 10,
  onError = () => {}
}) => {
  const batchSize = Math.max(1, Math.floor(Number(concurrency)) || 1);
  let administrators = [];
  try {
    administrators = await api('getChatAdministrators', { chat_id: chatId, return_bots: true });
  } catch (error) {
    onError('getChatAdministrators', { chatId }, error);
  }

  const verified = new Map(administrators
    .filter(isCurrentHumanMember)
    .map((member) => [String(member.user.id), member.user]));
  const candidates = knownUsers.filter((user) => user?.id && !verified.has(String(user.id)));

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const members = await Promise.all(batch.map(async (user) => {
      try {
        return await api('getChatMember', { chat_id: chatId, user_id: user.id });
      } catch (error) {
        onError('getChatMember', { chatId, userId: String(user.id) }, error);
        return null;
      }
    }));

    for (const member of members) {
      if (isCurrentHumanMember(member)) verified.set(String(member.user.id), member.user);
    }
  }

  return Array.from(verified.values());
};

export const buildMentionMessages = (users, {
  maxLength = 4096,
  header = defaultHeader
} = {}) => {
  if (maxLength <= header.length) throw new RangeError('maxLength must be longer than the header');

  const uniqueUsers = [];
  const seenUserIds = new Set();
  for (const user of users) {
    const id = String(user?.id || '');
    if (!id || user.is_bot || seenUserIds.has(id)) continue;
    seenUserIds.add(id);
    uniqueUsers.push(user);
  }
  const messages = [];
  let text = header;
  let entities = [];

  const flush = () => {
    if (!entities.length) return;
    messages.push({ text, entities });
    text = header;
    entities = [];
  };

  for (const user of uniqueUsers) {
    const name = displayName(user).slice(0, maxLength - header.length);
    let separator = entities.length ? ' · ' : '';

    if (text.length + separator.length + name.length > maxLength && entities.length) flush();

    separator = entities.length ? ' · ' : '';
    text += separator;
    const offset = text.length;
    text += name;
    entities.push(mentionEntity(user, offset, name.length));
  }

  flush();
  return messages;
};

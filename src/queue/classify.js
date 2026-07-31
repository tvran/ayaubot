import { extractSupportedVideoUrls } from '../media/service.js';

const heavyCommands = new Set(['q', 'qs', 'demotivation']);

const commandName = (message = {}) => {
  const text = String(message.text || message.caption || '').trim();
  return text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase() || null;
};

export const updateMessage = (update = {}) => update.message || update.edited_message || null;

export const classifyUpdateLane = (update = {}) => {
  const message = updateMessage(update);
  if (!message) return 'default';
  if (heavyCommands.has(commandName(message))) return 'heavy';
  if (/^#итогидня(?:\s|$)/iu.test(String(message.text || message.caption || '').trim())) return 'heavy';
  if (extractSupportedVideoUrls(message.text || message.caption || '', 1).length) return 'heavy';
  return 'default';
};

export const updateQueueRecord = (update = {}) => {
  const message = updateMessage(update);
  const updateId = Number(update.update_id);
  const chatId = Number(message?.chat?.id);
  if (!Number.isSafeInteger(updateId) || !Number.isSafeInteger(chatId)) return null;
  return {
    updateId,
    chatId,
    lane: classifyUpdateLane(update),
    payload: update
  };
};

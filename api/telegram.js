import { Redis } from '@upstash/redis';
import { createQuoteRenderer } from '../src/render/quote.js';

const token = process.env.BOT_TOKEN;
const allowedChatIds = (process.env.ALLOWED_CHAT_IDS || process.env.ALLOWED_CHAT_ID || '')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter(Boolean);
const webhookSecret = process.env.WEBHOOK_SECRET;
const stickerSetName = process.env.STICKER_SET_NAME;
const stickerSetTitle = process.env.STICKER_SET_TITLE || 'Group Quotes';
const botId = Number((token || '').split(':')[0]);

const redis = Redis.fromEnv();
const cacheTtlSeconds = 60 * 60 * 24 * 90;
const cacheLimit = 10000;

const api = async (method, payload, options = {}) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: options.formData ? payload : JSON.stringify(payload),
    headers: options.formData ? undefined : { 'content-type': 'application/json' }
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
};

const chatAllowed = (chatId) => allowedChatIds.length === 0 || allowedChatIds.includes(chatId);

const parseCommand = (message) => {
  const text = message.text || message.caption || '';
  const match = text.match(/^\/(qs|qd|q)(?:@\w+)?(?:\s+(\d{1,2}))?\s*$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    count: Math.min(Math.max(Number(match[2] || 1), 1), 10)
  };
};

const messagePayload = (message) => ({
  message_id: message.message_id,
  date: message.date,
  from: message.from,
  forward_origin: message.forward_origin,
  text: message.text,
  caption: message.caption,
  entities: message.entities,
  caption_entities: message.caption_entities,
  photo: message.photo,
  sticker: message.sticker,
  video_note: message.video_note,
  video: message.video
});

const cacheMessage = async (message) => {
  if (!message?.message_id || !chatAllowed(message.chat?.id)) return;
  const key = `chat:${message.chat.id}:timeline`;
  const itemKey = `chat:${message.chat.id}:message:${message.message_id}`;
  await redis.set(itemKey, messagePayload(message), { ex: cacheTtlSeconds });
  await redis.lpush(key, String(message.message_id));
  await redis.ltrim(key, 0, cacheLimit - 1);
  await redis.expire(key, cacheTtlSeconds);
};

const getCachedMessage = async (chatId, messageId) =>
  redis.get(`chat:${chatId}:message:${messageId}`);

const collectMessages = async (chatId, startId, count, beforeId) => {
  const messages = [];
  const ids = await redis.lrange(`chat:${chatId}:timeline`, 0, cacheLimit - 1);
  const selectedIds = Array.from(new Set(ids.map(Number)))
    .filter((id) => id >= startId && id < beforeId)
    .sort((a, b) => a - b);

  for (const id of selectedIds) {
    const message = await getCachedMessage(chatId, id);
    if (message && !parseCommand(message)) messages.push(message);
    if (messages.length >= count) break;
  }
  return messages;
};

const downloadTelegramFile = async (fileId) => {
  const file = await api('getFile', { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const quoteRenderer = createQuoteRenderer({ api, downloadTelegramFile });

const sendBuffer = async (method, chatId, fieldName, filename, buffer, extra = {}) => {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
  form.append(fieldName, new Blob([buffer]), filename);
  return api(method, form, { formData: true });
};

const sendQuote = async (chatId, commandMessage, messages) => {
  const sticker = await quoteRenderer.renderStickerWebp(messages);
  await sendBuffer('sendSticker', chatId, 'sticker', 'quote.webp', sticker, {
    reply_to_message_id: commandMessage.message_id
  });
};

const stickerInputFormValue = (name, emojis = '💬') =>
  JSON.stringify({
    sticker: `attach://${name}`,
    emoji_list: [emojis],
    format: 'static'
  });

const saveStickerBuffer = async (chatId, fromUserId, commandMessage, sticker) => {
  if (!stickerSetName) {
    await api('sendMessage', { chat_id: chatId, text: 'STICKER_SET_NAME is not configured.', reply_to_message_id: commandMessage.message_id });
    return;
  }

  const form = new FormData();
  form.append('user_id', String(fromUserId));
  form.append('name', stickerSetName);
  form.append('sticker', stickerInputFormValue('quote_file'));
  form.append('quote_file', new Blob([sticker]), 'quote.webp');

  try {
    await api('addStickerToSet', form, { formData: true });
  } catch (error) {
    const createForm = new FormData();
    createForm.append('user_id', String(fromUserId));
    createForm.append('name', stickerSetName);
    createForm.append('title', stickerSetTitle);
    createForm.append('stickers', JSON.stringify([{
      sticker: 'attach://sticker',
      emoji_list: ['💬'],
      format: 'static'
    }]));
    createForm.append('sticker', new Blob([sticker]), 'quote.webp');
    await api('createNewStickerSet', createForm, { formData: true });
  }

  await api('sendMessage', {
    chat_id: chatId,
    text: `Успешно добавлено в ваш [стикерпак группы](https://t.me/addstickers/${stickerSetName})✨`,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_to_message_id: commandMessage.message_id
  });
};

const saveQuotedSticker = async (chatId, fromUserId, commandMessage) => {
  const reply = commandMessage.reply_to_message;
  const sticker = reply?.sticker;

  if (!sticker || reply.from?.id !== botId || sticker.is_animated || sticker.is_video) {
    await api('sendMessage', {
      chat_id: chatId,
      text: 'First make it with /q, then reply to that sticker with /qs.',
      reply_to_message_id: commandMessage.message_id
    });
    return;
  }

  await saveStickerBuffer(chatId, fromUserId, commandMessage, await downloadTelegramFile(sticker.file_id));
};

const deleteSticker = async (chatId, commandMessage) => {
  const sticker = commandMessage.reply_to_message?.sticker;
  if (!sticker) {
    await api('sendMessage', { chat_id: chatId, text: 'Reply to a sticker with /qd.', reply_to_message_id: commandMessage.message_id });
    return;
  }
  await api('deleteStickerFromSet', { sticker: sticker.file_id });
  await api('sendMessage', { chat_id: chatId, text: 'Deleted.', reply_to_message_id: commandMessage.message_id });
};

const handleCommand = async (message, command) => {
  const chatId = message.chat.id;

  if (command.name === 'qd') {
    await deleteSticker(chatId, message);
    return;
  }

  if (command.name === 'qs') {
    await saveQuotedSticker(chatId, message.from.id, message);
    return;
  }

  const reply = message.reply_to_message;
  if (!reply) {
    await api('sendMessage', {
      chat_id: chatId,
      text: 'Reply to the first message you want quoted.',
      reply_to_message_id: message.message_id
    });
    return;
  }

  await cacheMessage(reply);
  const messages = await collectMessages(chatId, reply.message_id, command.count, message.message_id);
  if (!messages.length) {
    await api('sendMessage', {
      chat_id: chatId,
      text: 'I do not have those messages cached. Make me admin or disable privacy mode.',
      reply_to_message_id: message.message_id
    });
    return;
  }

  if (command.name === 'q') await sendQuote(chatId, message, messages);
};

export default async function handler(request, response) {
  try {
    if (request.method !== 'POST') {
      response.status(200).json({ ok: true });
      return;
    }
    if (webhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      response.status(401).json({ ok: false });
      return;
    }

    const update = request.body;
    const message = update.message || update.edited_message;
    if (!message) {
      response.status(200).json({ ok: true });
      return;
    }

    if (!chatAllowed(message.chat?.id)) {
      console.log('ignored chat', {
        id: message.chat?.id,
        title: message.chat?.title,
        type: message.chat?.type,
        text: message.text || message.caption || ''
      });
      response.status(200).json({ ok: true });
      return;
    }

    await cacheMessage(message);
    const command = parseCommand(message);
    if (command) await handleCommand(message, command);

    response.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    response.status(200).json({ ok: true });
  }
}

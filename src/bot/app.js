import { createQuoteRenderer } from '../render/quote.js';

const cacheTtlSeconds = 60 * 60 * 24 * 90;
const cacheLimit = 10000;

const parseAllowedChatIds = (env) =>
  new Set((env.ALLOWED_CHAT_IDS || env.ALLOWED_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean));

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

const buildHelpText = (percentCommand = 'percent') => [
  'Короче, что я умею, сладкие:',
  '',
  'Кидай ссылку на Instagram Reels или TikTok — скачаю и пришлю видео прямо в чат',
  '',
  '/q — делаю цитату-стикер из сообщения, на которое ты ответил',
  '/q 2 ... /q 10 — беру несколько сообщений подряд, без этой вашей хуйни',
  '/qs — сохраняю цитату из /q в стикерпак группы',
  '/qd — удаляю стикер из пака, если ответить на него',
  '',
  '/topwords — топ-5 слов за последние 14 дней, кто тут главный болтун',
  '/top — то же самое, но коротко, как твоя мотивация в понедельник',
  '/pidor — выбираю подозреваемого дня, строго без бота, я не участвую в этом цирке',
  '/pidor_list — история выборов',
  '/pidor_reset — сбросить выбор на сегодня',
  `/${percentCommand} <параметр> — измеряю человека в процентах; reply измеряет автора сообщения`,
  '',
  '/codeword_start — запускаю игру в кодовое слово',
  '/codeword — статус игры, че там по секретику',
  '/codeword_hint — подсказка: длина слова и кто его чаще юзал',
  '/codeword_stats — кто сколько раз побеждал',
  '/codeword_stop — стопаю игру, если вы заебались',
  '',
  '/birthday ДД.ММ.ГГГГ — записать или обновить свой день рождения',
  '/birthdays — календарь дней рождения этого чата',
  '/birthday_remove — удалить свой день рождения',
  '',
  '/help — показать эту красоту еще раз'
].join('\n');

export const parseCommand = (message) => {
  const text = message.text || message.caption || '';
  const match = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*?))?\s*$/i);
  if (!match) return null;
  const args = (match[2] || '').trim();
  const arg = args.split(/\s+/)[0]?.toLowerCase();
  const name = match[1].toLowerCase();
  const aliases = {
    'pidor:list': 'pidor_list',
    'pidor:reset': 'pidor_reset',
    'codeword:hint': 'codeword_hint',
    'codeword:stats': 'codeword_stats',
    'codeword:stop': 'codeword_stop',
    'codeword:start': 'codeword_start'
  };

  return {
    name: aliases[`${name}:${arg}`] || name,
    count: Math.min(Math.max(Number(/^\d+$/.test(arg || '') ? arg : 1), 1), 10),
    args
  };
};

export const createBotApp = ({
  env = process.env,
  redis,
  analytics,
  mediaDownloader,
  birthdays,
  percentGame
} = {}) => {
  const token = env.BOT_TOKEN;
  const allowedChatIds = parseAllowedChatIds(env);
  const stickerSetName = env.STICKER_SET_NAME;
  const stickerSetTitle = env.STICKER_SET_TITLE || 'Group Quotes';
  const stickerSetOwnerId = env.STICKER_SET_OWNER_ID;
  const botId = Number((token || '').split(':')[0]);
  const helpText = buildHelpText(percentGame?.command);

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

  console.log('bot config', {
    allowedChatIds: Array.from(allowedChatIds),
    stickerSetName,
    stickerSetOwnerConfigured: Boolean(stickerSetOwnerId),
    analyticsEnabled: Boolean(analytics),
    birthdaysEnabled: Boolean(birthdays?.enabled),
    percentGameEnabled: Boolean(percentGame?.enabled),
    redisEnabled: Boolean(redis),
    mediaDownloadsEnabled: Boolean(mediaDownloader?.enabled)
  });

  const chatAllowed = (chatId) => allowedChatIds.size === 0 || allowedChatIds.has(String(chatId));

  const cacheMessage = async (message) => {
    if (!redis || !message?.message_id || !chatAllowed(message.chat?.id)) return;
    const key = `chat:${message.chat.id}:timeline`;
    const itemKey = `chat:${message.chat.id}:message:${message.message_id}`;
    await redis.set(itemKey, messagePayload(message), { ex: cacheTtlSeconds });
    await redis.lpush(key, String(message.message_id));
    await redis.ltrim(key, 0, cacheLimit - 1);
    await redis.expire(key, cacheTtlSeconds);
  };

  const getCachedMessage = async (chatId, messageId) =>
    redis?.get(`chat:${chatId}:message:${messageId}`);

  const collectMessages = async (chatId, startId, count, beforeId) => {
    if (!redis) return [];
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

  const sendMessage = async (chatId, text, replyToMessageId, extra = {}) =>
    api('sendMessage', {
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      ...extra
    });

  const sendMessages = async (chatId, texts, replyToMessageId) => {
    for (const [index, text] of texts.entries()) {
      await sendMessage(chatId, text, index === 0 ? replyToMessageId : undefined);
    }
  };

  const sendQuote = async (chatId, commandMessage, messages) => {
    const sticker = await quoteRenderer.renderStickerWebp(messages);
    await sendBuffer('sendSticker', chatId, 'sticker', 'quote.webp', sticker, {
      reply_to_message_id: commandMessage.message_id
    });
  };

  const mediaErrorText = (error) => {
    if (error?.code === 'file_too_large') return 'Видео слишком большое для отправки. Ссылка мощная, а я пока нет.';
    if (error?.code === 'timeout') return 'Не успел скачать видео вовремя. Попробуй ещё раз чуть позже.';
    if (error?.code === 'spawn_failed') return 'Загрузчик видео не настроен. Админу нужен yt-dlp, вот такая производственная драма.';
    return 'Не смог скачать это видео. Возможно, оно приватное, удалено или площадка опять что-то сломала.';
  };

  const handleMediaLinks = async (message) => {
    const urls = mediaDownloader?.urlsFromMessage(message) || [];
    for (const url of urls) {
      try {
        await api('sendChatAction', { chat_id: message.chat.id, action: 'upload_video' });
        const video = await mediaDownloader.downloadVideo(url);
        await sendBuffer('sendVideo', message.chat.id, 'video', video.filename, video.buffer, {
          reply_to_message_id: message.message_id,
          supports_streaming: true
        });
      } catch (error) {
        console.error('media download failed', { url, code: error?.code, error });
        await sendMessage(message.chat.id, mediaErrorText(error), message.message_id);
      }
    }
  };

  const stickerInputFormValue = (name, emojis = '💬') =>
    JSON.stringify({
      sticker: `attach://${name}`,
      emoji_list: [emojis],
      format: 'static'
    });

  const isMissingStickerSetError = (error) =>
    /sticker set not found|stickerset_invalid|stickers? set .* not found/i.test(error?.message || '');

  const saveStickerBuffer = async (chatId, fromUserId, commandMessage, sticker) => {
    if (!stickerSetName) {
      await sendMessage(chatId, 'Стикерпак не настроен, пиздец. Позовите админа этого цирка.', commandMessage.message_id);
      return;
    }

    const ownerUserId = stickerSetOwnerId || fromUserId;
    const form = new FormData();
    form.append('user_id', String(ownerUserId));
    form.append('name', stickerSetName);
    form.append('sticker', stickerInputFormValue('quote_file'));
    form.append('quote_file', new Blob([sticker]), 'quote.webp');

    try {
      await api('addStickerToSet', form, { formData: true });
    } catch (error) {
      console.error('addStickerToSet failed', {
        stickerSetName,
        ownerUserId: String(ownerUserId),
        commandUserId: String(fromUserId),
        error: error.message
      });

      if (!isMissingStickerSetError(error)) {
        await sendMessage(chatId, 'Не смог добавить в стикерпак. В логах теперь есть настоящая причина, без этой маскировочной хуйни.', commandMessage.message_id);
        return;
      }

      const createForm = new FormData();
      createForm.append('user_id', String(ownerUserId));
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

    await sendMessage(
      chatId,
      `Готово, закинул в ваш [стикерпак группы](https://t.me/addstickers/${stickerSetName})✨ Красиво, аж неловко.`,
      commandMessage.message_id,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  };

  const saveQuotedSticker = async (chatId, fromUserId, commandMessage) => {
    const reply = commandMessage.reply_to_message;
    const sticker = reply?.sticker;

    if (!sticker || reply.from?.id !== botId || sticker.is_animated || sticker.is_video) {
      await sendMessage(chatId, 'Сначала сделай цитату через /q, потом ответь на МОЙ стикер командой /qs. Не усложняй, котик.', commandMessage.message_id);
      return;
    }

    await saveStickerBuffer(chatId, fromUserId, commandMessage, await downloadTelegramFile(sticker.file_id));
  };

  const deleteSticker = async (chatId, commandMessage) => {
    const sticker = commandMessage.reply_to_message?.sticker;
    if (!sticker) {
      await sendMessage(chatId, 'Ответь на стикер командой /qd, а то я что удалять должен, воздух?', commandMessage.message_id);
      return;
    }
    await api('deleteStickerFromSet', { sticker: sticker.file_id });
    await sendMessage(chatId, 'Удалил. Минус один шедевр, трагедия века.', commandMessage.message_id);
  };

  const handleQuoteCommand = async (message, command) => {
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
      await sendMessage(chatId, 'Ответь на первое сообщение, которое надо процитировать. Я не телепат, я просто красивый.', message.message_id);
      return;
    }

    await cacheMessage(reply);
    const messages = await collectMessages(chatId, reply.message_id, command.count, message.message_id);
    if (!messages.length) {
      await sendMessage(chatId, 'Не вижу эти сообщения в кеше. Сделайте меня админом или отключите privacy mode, а то я тут как слепой красавчик.', message.message_id);
      return;
    }

    await sendQuote(chatId, message, messages);
  };

  const handleAnalyticsCommand = async (message, command) => {
    const chatId = message.chat.id;
    if (command.name === 'help' || command.name === 'start') {
      await sendMessage(chatId, helpText, message.message_id);
      return true;
    }
    if (command.name === 'top' || command.name === 'topwords') {
      await sendMessage(chatId, await analytics.topWordsText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'pidor') {
      await analytics.ingestMessage(message);
      await sendMessages(chatId, await analytics.pidorOfDayMessages(chatId, botId), message.message_id);
      return true;
    }
    if (command.name === 'pidor_reset' || command.name === 'reset_pidor') {
      await sendMessage(chatId, await analytics.resetPidorText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'pidor_list') {
      await sendMessage(chatId, await analytics.pidorHistoryText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'codeword_start') {
      await sendMessage(chatId, await analytics.startCodewordText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'codeword_stop') {
      await sendMessage(chatId, await analytics.stopCodewordText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'codeword') {
      await sendMessage(chatId, await analytics.codewordStatusText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'codeword_hint') {
      await sendMessage(chatId, await analytics.codewordHintText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'codeword_stats') {
      await sendMessage(chatId, await analytics.codewordStatsText(chatId), message.message_id);
      return true;
    }
    return false;
  };

  const handleBirthdayCommand = async (message, command) => {
    if (!birthdays) return false;
    const chatId = message.chat.id;

    if (command.name === 'birthday' || command.name === 'bday') {
      await sendMessage(chatId, await birthdays.register(message, command.args), message.message_id);
      return true;
    }
    if (command.name === 'birthdays' || command.name === 'birthday_list') {
      await sendMessage(chatId, await birthdays.list(message), message.message_id);
      return true;
    }
    if (command.name === 'birthday_remove' || command.name === 'birthday_delete') {
      await sendMessage(chatId, await birthdays.remove(message), message.message_id);
      return true;
    }
    return false;
  };

  const handleUpdate = async (update) => {
    const message = update.message || update.edited_message;
    if (!message) return;

    if (!chatAllowed(message.chat?.id)) {
      console.log('ignored chat', {
        id: message.chat?.id,
        title: message.chat?.title,
        type: message.chat?.type,
        text: message.text || message.caption || ''
      });
      return;
    }

    await cacheMessage(message);
    const command = parseCommand(message);

    if (!command) {
      await analytics?.ingestMessage(message);
      const guessText = await analytics?.checkCodewordGuess(message);
      if (guessText) await sendMessage(message.chat.id, guessText, message.message_id);
      await handleMediaLinks(message);
      return;
    }

    if (['q', 'qs', 'qd'].includes(command.name)) {
      await handleQuoteCommand(message, command);
      return;
    }

    if (percentGame && command.name === percentGame.command) {
      await sendMessage(message.chat.id, await percentGame.playText(message, command.args), message.message_id);
      return;
    }

    if (await handleBirthdayCommand(message, command)) return;
    if (analytics && await handleAnalyticsCommand(message, command)) return;
  };

  return { api, chatAllowed, handleUpdate };
};

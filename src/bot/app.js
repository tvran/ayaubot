import { AsyncLocalStorage } from 'node:async_hooks';
import { createIsolatedQuoteRenderer } from '../render/isolated-quote.js';
import { createDemotivationRenderer } from '../render/demotivation.js';
import { createStickerRenderer } from '../render/sticker.js';
import {
  maxDemotivationTextLength,
  normalizeDemotivationText,
  replyDemotivationSource
} from '../demotivation/service.js';
import { replyPhotoFileId, staticStickerInput } from '../sticker/service.js';
import { classifyUpdateLane } from '../queue/classify.js';
import { fetchWithTimeout, waitWithSignal } from '../runtime/fetch.js';
import { buildMentionMessages, findMentionableUsers } from './mentions.js';

const cacheTtlSeconds = 60 * 60 * 24 * 90;
const cacheLimit = 10000;

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

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

const dailySummaryDay = (message) => {
  const match = String(message.text || message.caption || '').trim()
    .match(/^#итогидня(?:\s+(\d{1,2}\.\d{1,2}\.\d{4}))?\s*$/iu);
  if (!match) return null;
  if (!match[1]) return undefined;

  const [day, month, year] = match[1].split('.').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return 'invalid';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const buildHelpText = (percentCommand = 'percent') => [
  'Короче, что я умею, сладкие:',
  '',
  'Кидай ссылку на Instagram Reels или TikTok — скачаю и пришлю видео прямо в чат',
  '',
  '/q — делаю цитату-стикер из сообщения, на которое ты ответил',
  '/q 2 ... /q 10 — беру несколько сообщений подряд, без этой вашей хуйни',
  '/qs — сохраняю цитату из /q или фото в стикерпак группы',
  '/qd — удаляю стикер из пака, если ответить на него',
  '/demotivation <текст> — делаю демотиватор из изображения в reply',
  '/all — зову всех известных мне участников чата, кроме ботов',
  '',
  '/topwords — топ-5 слов за последние 14 дней, кто тут главный болтун',
  '/top — то же самое, но коротко, как твоя мотивация в понедельник',
  '/spam — кто больше всех написал сообщений за всё время',
  '#итогидня — краткий AI-итог сообщений за сегодня',
  '/court — абсурдный суд дня: один запуск на чат в сутки',
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
    'spam:stats': 'spam_stats',
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
  redisGateway,
  analytics,
  mediaDownloader,
  demotivationFrameExtractor,
  birthdays,
  percentGame,
  dailySummary,
  court,
  rateLimiter,
  metrics,
  fetchImpl = fetch,
  logger = console
} = {}) => {
  const token = env.BOT_TOKEN;
  const allowedChatIds = parseAllowedChatIds(env);
  const stickerSetName = env.STICKER_SET_NAME;
  const stickerSetTitle = env.STICKER_SET_TITLE || 'Group Quotes';
  const stickerSetOwnerId = env.STICKER_SET_OWNER_ID;
  const botId = Number((token || '').split(':')[0]);
  const helpText = buildHelpText(percentGame?.command);
  const context = new AsyncLocalStorage();
  const telegramApiTimeoutMs = positiveInteger(env.TELEGRAM_API_TIMEOUT_MS, 15_000);
  const telegramUploadTimeoutMs = positiveInteger(env.TELEGRAM_UPLOAD_TIMEOUT_MS, 120_000);
  const telegramFileTimeoutMs = positiveInteger(env.TELEGRAM_FILE_TIMEOUT_MS, 30_000);
  const telegramApiRetries = Math.min(positiveInteger(env.TELEGRAM_API_RETRIES, 2), 5);

  const redisCall = redisGateway?.call || (async (operation, callback, fallback) => {
    if (!redis) return fallback;
    const startedAt = Date.now();
    try {
      const result = await callback(redis);
      metrics?.increment('redis_operations_total', { operation, result: 'ok' });
      metrics?.observe('redis_operation_duration_seconds', (Date.now() - startedAt) / 1000, { operation });
      return result;
    } catch (error) {
      metrics?.increment('redis_operations_total', { operation, result: 'error' });
      logger.error('redis operation failed', { operation, error: error?.message || String(error) });
      return fallback;
    }
  });

  const api = async (method, payload, options = {}) => {
    const signal = options.signal || context.getStore()?.signal;
    const timeoutMs = options.formData ? telegramUploadTimeoutMs : telegramApiTimeoutMs;
    for (let attempt = 0; attempt <= telegramApiRetries; attempt += 1) {
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: 'POST',
            body: options.formData ? payload : JSON.stringify(payload),
            headers: options.formData ? undefined : { 'content-type': 'application/json' }
          },
          { timeoutMs, signal, label: `Telegram ${method}` }
        );
      } catch (error) {
        metrics?.observe('telegram_api_duration_seconds', (Date.now() - startedAt) / 1000, { method });
        metrics?.increment('telegram_api_requests_total', {
          method,
          result: error?.code || 'network_error'
        });
        throw error;
      }
      const data = await response.json().catch(() => ({
        ok: false,
        error_code: response.status,
        description: `HTTP ${response.status}`
      }));
      const durationSeconds = (Date.now() - startedAt) / 1000;
      metrics?.observe('telegram_api_duration_seconds', durationSeconds, { method });
      metrics?.increment('telegram_api_requests_total', {
        method,
        result: data.ok ? 'ok' : String(data.error_code || response.status || 'error')
      });
      if (data.ok) return data.result;

      const error = new Error(`${method}: ${data.description || `HTTP ${response.status}`}`);
      error.code = data.error_code || response.status;
      const retryable = Number(error.code) === 429 || Number(error.code) >= 500;
      if (!retryable || attempt >= telegramApiRetries) throw error;
      const retryAfterMs = Number(data.parameters?.retry_after) > 0
        ? Number(data.parameters.retry_after) * 1000
        : Math.min(5_000, 250 * (2 ** attempt));
      await waitWithSignal(retryAfterMs, signal);
    }
    throw new Error(`${method}: retry budget exhausted`);
  };

  logger.log('bot config', {
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
    await redisCall('cache_message', async (client) => {
      const pipeline = client.pipeline();
      pipeline.set(itemKey, messagePayload(message), { ex: cacheTtlSeconds });
      pipeline.lpush(key, String(message.message_id));
      pipeline.ltrim(key, 0, cacheLimit - 1);
      pipeline.expire(key, cacheTtlSeconds);
      return pipeline.exec();
    }, null);
  };

  const collectMessages = async (chatId, startId, count, beforeId) => {
    if (!redis) return [];
    return redisCall('collect_messages', async (client) => {
      const ids = await client.lrange(`chat:${chatId}:timeline`, 0, cacheLimit - 1);
      const selectedIds = Array.from(new Set(ids.map(Number)))
        .filter((id) => id >= startId && id < beforeId)
        .sort((a, b) => a - b);
      if (!selectedIds.length) return [];
      const values = await client.mget(...selectedIds.map((id) => `chat:${chatId}:message:${id}`));
      return values.filter((message) => message && !parseCommand(message)).slice(0, count);
    }, []);
  };

  const downloadTelegramFile = async (fileId) => {
    const file = await api('getFile', { file_id: fileId });
    const response = await fetchWithTimeout(
      fetchImpl,
      `https://api.telegram.org/file/bot${token}/${file.file_path}`,
      {},
      {
        timeoutMs: telegramFileTimeoutMs,
        signal: context.getStore()?.signal,
        label: 'Telegram file download'
      }
    );
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  const quoteRenderer = createIsolatedQuoteRenderer({ env });
  const demotivationRenderer = createDemotivationRenderer();
  const stickerRenderer = createStickerRenderer();

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

  const sendLongMessage = async (chatId, text, replyToMessageId, extra = {}) => {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 4096) {
      const boundary = Math.max(remaining.lastIndexOf('\n', 4000), remaining.lastIndexOf(' ', 4000));
      const index = boundary > 0 ? boundary : 4000;
      chunks.push(remaining.slice(0, index));
      remaining = remaining.slice(index).trimStart();
    }
    chunks.push(remaining);

    for (const [index, chunk] of chunks.entries()) {
      await sendMessage(chatId, chunk, index === 0 ? replyToMessageId : undefined, extra);
    }
  };

  const handleAllCommand = async (message) => {
    const chatId = message.chat.id;
    if (!['group', 'supergroup'].includes(message.chat.type)) {
      await sendMessage(chatId, '/all работает только в групповом чате.', message.message_id);
      return;
    }

    const knownRows = await analytics?.knownUsers?.(chatId);
    if (!knownRows) {
      await sendMessage(
        chatId,
        'Для /all нужен PostgreSQL: без него мне негде хранить список участников чата.',
        message.message_id
      );
      return;
    }

    const knownUsers = knownRows.map((row) => ({
      id: row.user_id,
      first_name: row.first_name,
      last_name: row.last_name,
      username: row.username
    }));
    const users = await findMentionableUsers({
      api,
      chatId,
      knownUsers,
      onError: (method, details, error) => {
        logger.error(`${method} failed`, { ...details, error: error.message });
      }
    });
    users.sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }));

    const mentionMessages = buildMentionMessages(users);
    if (!mentionMessages.length) {
      await sendMessage(
        chatId,
        'Не нашёл ни одного живого участника. Если я не админ, Telegram может не дать мне проверить состав чата.',
        message.message_id
      );
      return;
    }

    for (const [index, mention] of mentionMessages.entries()) {
      await sendMessage(chatId, mention.text, index === 0 ? message.message_id : undefined, {
        entities: mention.entities
      });
    }
  };

  const handleDemotivationCommand = async (message, command) => {
    const chatId = message.chat.id;
    const text = normalizeDemotivationText(command.args);
    if (!text) {
      await sendMessage(
        chatId,
        'Добавь текст после команды: `/demotivation Хьюстон, у нас проблемы`.',
        message.message_id,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (Array.from(text).length > maxDemotivationTextLength) {
      await sendMessage(
        chatId,
        `Текст слишком длинный. Максимум ${maxDemotivationTextLength} символов, иначе получится не демотиватор, а дипломная работа.`,
        message.message_id
      );
      return;
    }

    const source = replyDemotivationSource(message.reply_to_message);
    if (!source) {
      await sendMessage(
        chatId,
        'Ответь командой на фото, картинку-файл, статический стикер или видеокружок. Из воздуха рамку не заполню.',
        message.message_id
      );
      return;
    }

    try {
      await api('sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      const sourceBuffer = await downloadTelegramFile(source.fileId);
      const imageBuffer = source.kind === 'video_note'
        ? await demotivationFrameExtractor.extractFirstFrame(sourceBuffer, {
          signal: context.getStore()?.signal
        })
        : sourceBuffer;
      const rendered = await demotivationRenderer.renderJpeg(
        imageBuffer,
        text
      );
      await sendBuffer('sendPhoto', chatId, 'photo', 'demotivation.jpg', rendered, {
        reply_to_message_id: message.message_id
      });
    } catch (error) {
      logger.error('demotivation render failed', {
        chatId,
        fileId: source.fileId,
        sourceKind: source.kind,
        error
      });
      await sendMessage(
        chatId,
        'Не смог собрать демотиватор из этого изображения или видеокружка. Попробуй другой исходник.',
        message.message_id
      );
    }
  };

  const sendQuote = async (chatId, commandMessage, messages) => {
    const startedAt = Date.now();
    let sticker;
    try {
      sticker = await quoteRenderer.renderStickerWebp(messages, {
        signal: context.getStore()?.signal
      });
      metrics?.increment('quote_renders_total', { result: 'ok' });
    } catch (error) {
      metrics?.increment('quote_renders_total', { result: error?.code || 'error' });
      logger.error('quote render failed', {
        chatId,
        messageId: commandMessage.message_id,
        durationMs: Date.now() - startedAt,
        code: error?.code,
        error: error?.message || String(error)
      });
      if (context.getStore()?.signal?.aborted) throw error;
      await sendMessage(
        chatId,
        'Не смог отрендерить цитату вовремя. Процесс прибил, очередь дальше не держу — попробуй ещё раз попроще.',
        commandMessage.message_id
      );
      return;
    } finally {
      metrics?.observe('quote_render_duration_seconds', (Date.now() - startedAt) / 1000);
    }
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
        const video = await mediaDownloader.downloadVideo(url, {
          signal: context.getStore()?.signal
        });
        await sendBuffer('sendVideo', message.chat.id, 'video', video.filename, video.buffer, {
          reply_to_message_id: message.message_id,
          supports_streaming: true
        });
      } catch (error) {
        logger.error('media download failed', { url, code: error?.code, error });
        await sendMessage(message.chat.id, mediaErrorText(error), message.message_id);
      }
    }
  };

  const isMissingStickerSetError = (error) =>
    /sticker set not found|stickerset_invalid|stickers? set .* not found/i.test(error?.message || '');

  const stickerSetConfigured = async (chatId, commandMessage) => {
    if (!stickerSetName) {
      await sendMessage(chatId, 'Стикерпак не настроен, пиздец. Позовите админа этого цирка.', commandMessage.message_id);
      return false;
    }
    return true;
  };

  const uploadStickerBuffer = async (ownerUserId, sticker) => {
    const form = new FormData();
    form.append('user_id', String(ownerUserId));
    form.append('sticker_format', 'static');
    form.append('sticker', new Blob([sticker], { type: 'image/webp' }), 'sticker.webp');
    const uploaded = await api('uploadStickerFile', form, { formData: true });
    if (!uploaded?.file_id) throw new Error('uploadStickerFile returned no file_id');
    return uploaded.file_id;
  };

  const saveStickerReference = async (chatId, fromUserId, commandMessage, stickerFileId) => {
    if (!await stickerSetConfigured(chatId, commandMessage)) return;

    const ownerUserId = stickerSetOwnerId || fromUserId;
    const sticker = staticStickerInput(stickerFileId);

    try {
      await api('addStickerToSet', {
        user_id: ownerUserId,
        name: stickerSetName,
        sticker
      });
    } catch (error) {
      logger.error('addStickerToSet failed', {
        stickerSetName,
        ownerUserId: String(ownerUserId),
        commandUserId: String(fromUserId),
        error: error.message
      });

      if (!isMissingStickerSetError(error)) {
        await sendMessage(chatId, 'Не смог добавить в стикерпак. В логах теперь есть настоящая причина, без этой маскировочной хуйни.', commandMessage.message_id);
        return;
      }

      await api('createNewStickerSet', {
        user_id: ownerUserId,
        name: stickerSetName,
        title: stickerSetTitle,
        stickers: [sticker]
      });
    }

    await sendMessage(
      chatId,
      `Готово, закинул в ваш [стикерпак группы](https://t.me/addstickers/${stickerSetName})✨ Красиво, аж неловко.`,
      commandMessage.message_id,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  };

  const saveStickerBuffer = async (chatId, fromUserId, commandMessage, sticker) => {
    if (!await stickerSetConfigured(chatId, commandMessage)) return;

    const ownerUserId = stickerSetOwnerId || fromUserId;
    let stickerFileId;
    try {
      stickerFileId = await uploadStickerBuffer(ownerUserId, sticker);
    } catch (error) {
      logger.error('uploadStickerFile failed', {
        ownerUserId: String(ownerUserId),
        commandUserId: String(fromUserId),
        error: error.message
      });
      await sendMessage(
        chatId,
        'Не смог подготовить фотографию для стикерпака. В логах сохранил причину.',
        commandMessage.message_id
      );
      return;
    }

    await saveStickerReference(chatId, fromUserId, commandMessage, stickerFileId);
  };

  const saveQuotedSticker = async (chatId, fromUserId, commandMessage) => {
    const reply = commandMessage.reply_to_message;
    const photoFileId = replyPhotoFileId(reply);

    if (photoFileId) {
      let photoSticker;
      try {
        photoSticker = await stickerRenderer.renderPhotoWebp(
          await downloadTelegramFile(photoFileId)
        );
      } catch (error) {
        logger.error('photo sticker render failed', { chatId, photoFileId, error });
        await sendMessage(
          chatId,
          'Не смог превратить это фото в стикер. Попробуй другую фотографию.',
          commandMessage.message_id
        );
        return;
      }

      await saveStickerBuffer(chatId, fromUserId, commandMessage, photoSticker);
      return;
    }

    const sticker = reply?.sticker;

    if (!sticker || reply.from?.id !== botId || sticker.is_animated || sticker.is_video) {
      await sendMessage(chatId, 'Ответь командой /qs на фотографию или на МОЙ статический стикер из /q. Не усложняй, котик.', commandMessage.message_id);
      return;
    }

    await saveStickerReference(chatId, fromUserId, commandMessage, sticker.file_id);
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
    if (command.name === 'spam' || command.name === 'spam_stats') {
      await sendMessage(chatId, await analytics.spamStatsText(chatId), message.message_id);
      return true;
    }
    if (command.name === 'pidor') {
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

  const handleUpdateInner = async (update) => {
    const callback = update.callback_query;
    if (callback?.data?.startsWith('court:')) {
      const [, id, optionId] = callback.data.split(':');
      const result = await court?.vote({ id: Number(id), voterId: callback.from?.id, optionId: Number(optionId) });
      await api('answerCallbackQuery', { callback_query_id: callback.id, text: result?.duplicate ? 'Ты уже проголосовал.' : 'голос учтён' });
      const item = await court?.session(Number(id));
      if (item && result?.closed) await api('editMessageText', { chat_id: item.chat_id, message_id: item.message_id, text: court.text(item, true) });
      return;
    }
    const message = update.message || update.edited_message;
    if (!message) return;

    if (!chatAllowed(message.chat?.id)) {
      logger.log('ignored chat', {
        id: message.chat?.id,
        title: message.chat?.title,
        type: message.chat?.type,
        text: message.text || message.caption || ''
      });
      return;
    }

    await cacheMessage(message);
    const summaryDay = dailySummaryDay(message);
    if (summaryDay === 'invalid') {
      await sendMessage(message.chat.id, 'Дата должна быть настоящей: `#итогидня 24.07.2026`.', message.message_id, { parse_mode: 'Markdown' });
      return;
    }
    if (summaryDay !== null) {
      if (!dailySummary) {
        await sendMessage(message.chat.id, 'Итоги дня пока не настроены. Нужны PostgreSQL и OPENAI_API_KEY.', message.message_id);
        return;
      }
      const text = await dailySummary.summaryText(message.chat.id, summaryDay, {
        signal: context.getStore()?.signal
      });
      await sendLongMessage(message.chat.id, text, message.message_id, { disable_web_page_preview: true });
      return;
    }
    const command = parseCommand(message);

    if (command?.name === 'court') {
      const result = await court?.start(message.chat.id, (chatId, text, extra) => sendMessage(chatId, text, message.message_id, extra));
      if (result?.error) await sendMessage(message.chat.id, result.error, message.message_id);
      if (result?.existing) await sendMessage(message.chat.id, 'Суд дня уже идёт или уже состоялся.', message.message_id);
      return;
    }

    if (!command) {
      await analytics?.ingestMessage(message);
      const guessText = await analytics?.checkCodewordGuess(message);
      if (guessText) await sendMessage(message.chat.id, guessText, message.message_id);
      if (classifyUpdateLane(update) === 'heavy' && rateLimiter) {
        const limit = rateLimiter.consume({
          chatId: message.chat.id,
          userId: message.from?.id,
          kind: 'heavy'
        });
        if (!limit.allowed) {
          metrics?.increment('bot_rate_limited_total', { kind: 'heavy' });
          await sendMessage(
            message.chat.id,
            `Слишком много тяжёлых запросов. Подожди ${limit.retryAfterSeconds} сек.`,
            message.message_id
          );
          return;
        }
      }
      await handleMediaLinks(message);
      return;
    }

    if (rateLimiter) {
      const kind = classifyUpdateLane(update) === 'heavy' ? 'heavy' : 'command';
      const limit = rateLimiter.consume({
        chatId: message.chat.id,
        userId: message.from?.id,
        kind
      });
      if (!limit.allowed) {
        metrics?.increment('bot_rate_limited_total', { kind });
        await sendMessage(
          message.chat.id,
          `Слишком часто. Подожди ${limit.retryAfterSeconds} сек.`,
          message.message_id
        );
        return;
      }
    }

    await analytics?.rememberParticipants?.(message);

    if (['q', 'qs', 'qd'].includes(command.name)) {
      await handleQuoteCommand(message, command);
      return;
    }

    if (command.name === 'demotivation') {
      await handleDemotivationCommand(message, command);
      return;
    }

    if (percentGame && command.name === percentGame.command) {
      await sendMessage(message.chat.id, await percentGame.playText(message, command.args), message.message_id);
      return;
    }

    if (command.name === 'all') {
      await handleAllCommand(message);
      return;
    }

    if (await handleBirthdayCommand(message, command)) return;
    if (analytics && await handleAnalyticsCommand(message, command)) return;
  };

  const handleUpdate = (update, executionContext = {}) =>
    context.run(executionContext, () => handleUpdateInner(update));

  return { api, chatAllowed, handleUpdate };
};

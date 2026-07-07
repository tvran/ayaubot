import { Redis } from '@upstash/redis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';

const token = process.env.BOT_TOKEN;
const allowedChatIds = (process.env.ALLOWED_CHAT_IDS || process.env.ALLOWED_CHAT_ID || '')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter(Boolean);
const webhookSecret = process.env.WEBHOOK_SECRET;
const stickerSetName = process.env.STICKER_SET_NAME;
const stickerSetTitle = process.env.STICKER_SET_TITLE || 'Group Quotes';

const redis = Redis.fromEnv();
const regularFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Regular.ttf'));
const semiBoldFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-SemiBold.ttf'));
const boldFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Bold.ttf'));
const italicFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Italic.ttf'));
const semiBoldItalicFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-SemiBoldItalic.ttf'));
const userColors = ['#ffb86c', '#8be9fd', '#50fa7b', '#ff79c6', '#bd93f9', '#f1fa8c', '#ff6b6b', '#7dd3fc'];
const cacheTtlSeconds = 60 * 60 * 24 * 90;
const cacheLimit = 10000;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiCache = new Map();

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

const el = (type, props, ...children) => ({
  type,
  props: {
    ...props,
    style: type === 'div'
      ? { display: 'flex', ...(props?.style || {}) }
      : props?.style,
    children: children.flat().filter((child) => child !== null && child !== undefined)
  }
});

const parseCommand = (message) => {
  const text = message.text || message.caption || '';
  const match = text.match(/^\/(qs|qd|q)(?:@\w+)?(?:\s+(\d{1,2}))?\s*$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    count: Math.min(Math.max(Number(match[2] || 1), 1), 10)
  };
};

const userName = (user = {}) =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown';

const userColor = (user = {}) => userColors[Math.abs(Number(user.id || 0)) % userColors.length];

const quoteUser = (message) => {
  const origin = message.forward_origin;
  if (origin?.type === 'user' && origin.sender_user) return origin.sender_user;
  if (origin?.type === 'hidden_user' && origin.sender_user_name) {
    return { first_name: origin.sender_user_name };
  }
  if (origin?.type === 'chat' && origin.sender_chat) {
    return {
      id: origin.sender_chat.id,
      first_name: origin.sender_chat.title || origin.sender_chat.username || 'Forwarded'
    };
  }
  return message.from;
};

const initials = (user = {}) =>
  userName(user)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const segmentsWithEntities = (message) => {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  if (!text) return [];

  return Array.from(segmenter.segment(text)).map(({ segment, index }) => {
    const active = entities.filter((entity) => index >= entity.offset && index < entity.offset + entity.length);
    return {
      text: segment,
      emoji: /\p{Extended_Pictographic}/u.test(segment),
      bold: active.some((entity) => entity.type === 'bold'),
      italic: active.some((entity) => entity.type === 'italic'),
      underline: active.some((entity) => entity.type === 'underline'),
      strike: active.some((entity) => entity.type === 'strikethrough'),
      code: active.some((entity) => entity.type === 'code' || entity.type === 'pre')
    };
  });
};

const plainSegments = (text = '') =>
  Array.from(segmenter.segment(text)).map(({ segment }) => ({
    text: segment,
    emoji: /\p{Extended_Pictographic}/u.test(segment),
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false
  }));

const sameStyle = (left, right) =>
  !left.emoji &&
  !right.emoji &&
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.strike === right.strike &&
  left.code === right.code &&
  left.emoji === right.emoji;

const visibleText = (text) =>
  text
    .replaceAll(' ', '\u00a0')
    .replaceAll('\t', '\u00a0\u00a0\u00a0\u00a0');

const segmentWidth = (segment) => {
  if (segment.text === '\t') return 4;
  if (segment.emoji) return 2;
  return 1;
};

const textLineWidth = (line, fontSize = 30) =>
  Math.ceil(line.reduce((total, segment) => total + segmentWidth(segment), 0) * fontSize * 0.64);

const emojiCode = (value) =>
  Array.from(value)
    .map((char) => char.codePointAt(0).toString(16))
    .filter((code) => code !== 'fe0f')
    .join('-');

const emojiDataUri = async (value) => {
  const code = emojiCode(value);
  if (emojiCache.has(code)) return emojiCache.get(code);

  const apple = await fetch(`https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/${code}.png`);
  if (apple.ok) {
    const image = Buffer.from(await apple.arrayBuffer());
    const uri = `data:image/png;base64,${image.toString('base64')}`;
    emojiCache.set(code, uri);
    return uri;
  }

  const response = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${code}.svg`);
  if (!response.ok) return null;
  const svg = await response.text();
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  emojiCache.set(code, uri);
  return uri;
};

const wrapSegments = (segments, maxChars = 34) => {
  const lines = [];
  let line = [];
  let count = 0;

  const lineWidth = (items) => items.reduce((total, item) => total + segmentWidth(item), 0);

  for (const segment of segments) {
    const width = segmentWidth(segment);

    if (segment.text === '\n') {
      lines.push(line);
      line = [];
      count = 0;
      continue;
    }

    if (count + width > maxChars && line.length) {
      const breakIndex = line.map((item) => /\s/u.test(item.text)).lastIndexOf(true);
      if (breakIndex > 0) {
        lines.push(line.slice(0, breakIndex));
        line = line.slice(breakIndex + 1);
        count = lineWidth(line);
      } else {
        lines.push(line);
        line = [];
        count = 0;
      }
    }

    line.push(segment);
    count += width;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
};

const lineElements = async (line) => {
  const runs = line.reduce((items, segment) => {
    const previous = items.at(-1);
    if (previous && sameStyle(previous, segment)) previous.text += segment.text;
    else items.push({ ...segment });
    return items;
  }, []);

  return Promise.all(runs.map(async (segment, index) => {
    if (segment.emoji) {
      const src = await emojiDataUri(segment.text);
      if (src) {
        return el('img', {
          key: index,
          src,
          style: {
            width: 34,
            height: 34,
            margin: '0 2px',
            objectFit: 'contain'
          }
        });
      }
    }

    return (
    el('span', {
      key: index,
      style: {
        fontWeight: segment.bold ? 800 : 600,
        fontStyle: segment.italic ? 'italic' : 'normal',
        textDecoration: segment.underline ? 'underline' : segment.strike ? 'line-through' : 'none',
        fontFamily: 'Noto Sans Quote',
        whiteSpace: 'pre'
      }
    }, visibleText(segment.text))
    );
  }));
};

const avatarDataUri = async (user) => {
  if (!user?.id) return null;
  const photos = await api('getUserProfilePhotos', { user_id: user.id, limit: 1 });
  const fileId = photos.photos?.[0]?.at(-1)?.file_id;
  if (!fileId) return null;

  const buffer = await downloadTelegramFile(fileId);
  const avatar = await sharp(buffer)
    .resize(104, 104, { fit: 'cover' })
    .png()
    .toBuffer();
  return `data:image/png;base64,${avatar.toString('base64')}`;
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
    .sort((a, b) => a - b)
    .slice(0, count);

  for (const id of selectedIds) {
    const message = await getCachedMessage(chatId, id);
    if (message) messages.push(message);
  }
  return messages;
};

const downloadTelegramFile = async (fileId) => {
  const file = await api('getFile', { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const bestPhotoFileId = (message) => {
  const photos = message.photo || [];
  return photos[photos.length - 1]?.file_id;
};

const fitSize = (width, height, maxWidth = 560, maxHeight = 560) => {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

const mediaFileId = (message) => {
  if (bestPhotoFileId(message)) return { fileId: bestPhotoFileId(message), format: 'jpeg' };

  if (message.sticker?.file_id && !message.sticker.is_animated && !message.sticker.is_video) {
    return { fileId: message.sticker.file_id, format: 'png' };
  }

  if (message.sticker?.thumbnail?.file_id) return { fileId: message.sticker.thumbnail.file_id, format: 'png' };
  if (message.video_note?.thumbnail?.file_id) return { fileId: message.video_note.thumbnail.file_id, format: 'jpeg', circle: true };
  if (message.video?.thumbnail?.file_id) return { fileId: message.video.thumbnail.file_id, format: 'jpeg' };

  return null;
};

const mediaDataUri = async (message) => {
  const media = mediaFileId(message);
  if (!media) return null;

  const buffer = await downloadTelegramFile(media.fileId);
  const metadata = await sharp(buffer).metadata();
  const baseWidth = metadata.width || 636;
  const baseHeight = metadata.height || 420;
  const size = media.circle
    ? { width: Math.min(360, Math.max(baseWidth, baseHeight)), height: Math.min(360, Math.max(baseWidth, baseHeight)) }
    : fitSize(baseWidth, baseHeight);
  const resized = sharp(buffer).resize({
    ...size,
    fit: media.circle ? 'cover' : 'inside',
    withoutEnlargement: true
  });
  const image = media.format === 'png'
    ? await resized.png().toBuffer()
    : await resized.jpeg({ quality: 88 }).toBuffer();

  return {
    uri: `data:image/${media.format};base64,${image.toString('base64')}`,
    width: size.width,
    height: size.height,
    circle: media.circle
  };
};

const fallbackSegments = (message) => {
  if (message.video_note) return plainSegments('video message');
  if (message.video) return plainSegments('video');
  if (message.sticker) return plainSegments('sticker');
  return [];
};

const senderKey = (message) => {
  const user = quoteUser(message);
  return user?.id || user?.username || userName(user);
};

const tailUri = `data:image/svg+xml;base64,${Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <path fill="#16233f" d="M28 0v28H0c15.5 0 28-12.5 28-28z"/>
  </svg>
`).toString('base64')}`;

const bubbleRadius = (role) => {
  if (role === 'top') return '28px 28px 28px 10px';
  if (role === 'middle') return '10px 28px 28px 10px';
  if (role === 'bottom') return '10px 28px 28px 0';
  return '28px 28px 28px 0';
};

const quoteTree = async (messages) => {
  const leftPadding = 24;
  const bubblePaddingX = 36;
  const blocks = [];
  let y = 24;
  let canvasWidth = 0;

  for (const [index, message] of messages.entries()) {
    const user = quoteUser(message);
    const name = userName(user);
    const color = userColor(user);
    const senderId = senderKey(message);
    const samePrevious = index > 0 && senderKey(messages[index - 1]) === senderId;
    const sameNext = index < messages.length - 1 && senderKey(messages[index + 1]) === senderId;
    const firstInGroup = !samePrevious;
    const lastInGroup = !sameNext;
    const role = firstInGroup && lastInGroup
      ? 'single'
      : firstInGroup
        ? 'top'
        : lastInGroup
          ? 'bottom'
          : 'middle';
    const continuation = !firstInGroup;
    const renderAvatar = lastInGroup;
    const avatar = renderAvatar ? await avatarDataUri(user) : null;
    const media = await mediaDataUri(message);
    const textSegments = segmentsWithEntities(message);
    const hasText = textSegments.length > 0;
    const mediaOnly = Boolean(media && !hasText);
    const lines = hasText ? wrapSegments(textSegments) : media ? [] : wrapSegments(fallbackSegments(message));
    const nameElements = await lineElements(plainSegments(name));
    const bodyLineElements = await Promise.all(lines.map((line) => lineElements(line)));
    const nameWidth = Math.min(520, Math.ceil(Array.from(name).length * 28 * 0.54));
    const textWidth = lines.length ? Math.max(...lines.map((line) => textLineWidth(line))) : 0;
    const contentWidth = Math.max(180, nameWidth, textWidth, media?.width || 0);
    const avatarSize = contentWidth > 560 ? 76 : 104;
    const gap = contentWidth > 560 ? 14 : 20;
    const bubbleLeft = leftPadding + avatarSize + gap;
    const compactPaddingX = 26;
    const bubbleWidth = mediaOnly
      ? Math.max(media.width, continuation ? 180 : nameWidth + bubblePaddingX * 2)
      : Math.min(840, contentWidth + compactPaddingX * 2);
    const currentBubbleLeft = bubbleLeft;
    const displayMediaWidth = mediaOnly ? bubbleWidth : media?.width;
    const displayMediaHeight = mediaOnly && media
      ? media.circle
        ? bubbleWidth
        : Math.round(media.height * (bubbleWidth / media.width))
      : media?.height;
    const textHeight = lines.length * 36;
    const mediaHeight = displayMediaHeight || 0;
    const headerHeight = continuation ? 0 : 18 + 32 + 8;
    const contentHeight = (continuation ? 10 : 18) + (continuation ? 0 : 32) + (continuation ? 0 : 8) + textHeight + (media ? 14 + mediaHeight : 0) + (continuation ? 10 : 20);
    const mediaOnlyHeight = headerHeight + mediaHeight;
    const bubbleHeight = mediaOnly ? mediaOnlyHeight : messages.length > 1 ? contentHeight : Math.max(104, contentHeight);
    const blockHeight = renderAvatar ? Math.max(avatarSize, bubbleHeight) : bubbleHeight;
    const bubbleTop = 0;
    const avatarTop = blockHeight - avatarSize;
    canvasWidth = Math.max(canvasWidth, currentBubbleLeft + bubbleWidth + leftPadding);

    blocks.push(el('div', {
      key: message.message_id,
      style: {
        position: 'absolute',
        left: 0,
        top: y,
        width: currentBubbleLeft + bubbleWidth + leftPadding,
        height: blockHeight,
        display: 'flex'
      }
    },
      renderAvatar
        ? avatar
          ? el('img', {
            src: avatar,
            style: {
              position: 'absolute',
              left: leftPadding,
              top: avatarTop,
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2,
              objectFit: 'cover'
            }
          })
          : el('div', {
            style: {
              position: 'absolute',
              left: leftPadding,
              top: avatarTop,
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2,
              backgroundColor: color,
              color: '#16233f',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: avatarSize > 80 ? 32 : 24,
              fontWeight: 800
            }
          }, initials(user))
        : null,
      renderAvatar ? el('img', {
        src: tailUri,
        style: {
          position: 'absolute',
          left: currentBubbleLeft - 28,
          top: blockHeight - 28,
          width: 28,
          height: 28
        }
      }) : null,
      el('div', {
        style: {
          position: 'absolute',
          left: currentBubbleLeft,
          top: bubbleTop,
          width: bubbleWidth,
          minHeight: bubbleHeight,
          borderRadius: bubbleRadius(role),
          backgroundColor: '#16233f',
          padding: mediaOnly ? continuation ? 0 : '18px 0 0 0' : continuation ? '10px 18px 10px 26px' : '18px 26px 20px 26px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }
      },
        continuation ? null : el('div', {
          style: {
            color,
            fontSize: 28,
            lineHeight: '32px',
            fontWeight: 800,
            marginBottom: 8,
            marginLeft: mediaOnly ? 26 : 0,
            marginRight: mediaOnly ? 26 : 0,
            fontFamily: 'Noto Sans Quote',
            display: 'flex',
            flexDirection: 'row'
          }
        }, nameElements),
        ...mediaOnly ? [] : lines.map((line, index) =>
          el('div', {
            key: index,
            style: {
              color: '#ffffff',
              fontSize: 30,
              lineHeight: '36px',
              fontWeight: 600,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              fontFamily: 'Noto Sans Quote'
            }
          }, bodyLineElements[index])
        ),
        media ? el('img', {
          src: media.uri,
          style: {
            width: displayMediaWidth,
            height: displayMediaHeight,
            objectFit: media.circle ? 'cover' : 'contain',
            borderRadius: mediaOnly ? continuation ? media.circle ? 999 : 18 : media.circle ? 999 : '0 0 28px 28px' : 18,
            marginTop: mediaOnly ? continuation ? 0 : 8 : 14,
            alignSelf: 'center'
          }
        }) : null
      )
    ));
    y += blockHeight + (sameNext ? 6 : 22);
  }

  const height = Math.max(180, y + 2);
  const width = Math.max(260, canvasWidth);
  return {
    width,
    height,
    tree: el('div', {
      style: {
        position: 'relative',
        width,
        height,
        display: 'flex',
        backgroundColor: 'transparent',
        fontFamily: 'Noto Sans Quote'
      }
    }, blocks)
  };
};

const renderQuoteSvg = async (messages) => {
  const quote = await quoteTree(messages);
  const svg = await satori(quote.tree, {
    width: quote.width,
    height: quote.height,
    fonts: [
      { name: 'Noto Sans Quote', data: regularFont, weight: 400, style: 'normal' },
      { name: 'Noto Sans Quote', data: semiBoldFont, weight: 600, style: 'normal' },
      { name: 'Noto Sans Quote', data: boldFont, weight: 800, style: 'normal' },
      { name: 'Noto Sans Quote', data: italicFont, weight: 400, style: 'italic' },
      { name: 'Noto Sans Quote', data: semiBoldItalicFont, weight: 600, style: 'italic' }
    ]
  });
  return Buffer.from(svg);
};

const renderQuotePng = async (messages) =>
  sharp(await renderQuoteSvg(messages)).png().toBuffer();

const renderStickerWebp = async (messages) => {
  const resized = sharp(await renderQuoteSvg(messages))
    .resize({ width: 512, height: 470, fit: 'inside', withoutEnlargement: true });

  return resized
    .extend({
      bottom: 42,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ quality: 88 })
    .toBuffer();
};

const sendBuffer = async (method, chatId, fieldName, filename, buffer, extra = {}) => {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
  form.append(fieldName, new Blob([buffer]), filename);
  return api(method, form, { formData: true });
};

const sendQuote = async (chatId, commandMessage, messages) => {
  const sticker = await renderStickerWebp(messages);
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

const saveSticker = async (chatId, fromUserId, commandMessage, messages) => {
  if (!stickerSetName) {
    await api('sendMessage', { chat_id: chatId, text: 'STICKER_SET_NAME is not configured.', reply_to_message_id: commandMessage.message_id });
    return;
  }

  const sticker = await renderStickerWebp(messages);
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
    text: `Saved: https://t.me/addstickers/${stickerSetName}`,
    reply_to_message_id: commandMessage.message_id
  });
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
  if (command.name === 'qs') await saveSticker(chatId, message.from.id, message, messages);
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

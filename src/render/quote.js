import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';
import { theme } from './theme.js';

const regularFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Regular.ttf'));
const semiBoldFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-SemiBold.ttf'));
const boldFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Bold.ttf'));
const italicFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Italic.ttf'));
const semiBoldItalicFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-SemiBoldItalic.ttf'));

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiCache = new Map();

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

const userName = (user = {}) =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown';

const userColor = (user = {}) => theme.userColors[Math.abs(Number(user.id || 0)) % theme.userColors.length];

const quoteUser = (message) => {
  const origin = message.forward_origin;
  if (origin?.type === 'user' && origin.sender_user) return origin.sender_user;
  if (origin?.type === 'hidden_user' && origin.sender_user_name) return { first_name: origin.sender_user_name };
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
    .slice(0, 1)
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

const charWidthFactor = (char) => {
  if (/\s/u.test(char)) return 0.34;
  if (/[ilI.,:;!'|]/u.test(char)) return 0.31;
  if (/[mwMW@#%&]/u.test(char)) return 0.74;
  if (/[A-ZА-ЯЁ]/u.test(char)) return 0.76;
  if (/[а-яё]/u.test(char)) return 0.7;
  if (/[a-z0-9]/u.test(char)) return 0.5;
  return 0.58;
};

const segmentWidth = (segment, fontSize = theme.text.bodySize) => {
  if (segment.text === '\t') return fontSize * 1.36;
  if (segment.emoji) return fontSize * 1.08;
  return Array.from(segment.text).reduce((total, char) => total + fontSize * charWidthFactor(char), 0) * (segment.bold ? 1.04 : 1);
};

const linePixelWidth = (line, fontSize = theme.text.bodySize) =>
  line.reduce((total, segment) => total + segmentWidth(segment, fontSize), 0);

const lineWords = (line) =>
  line
    .map((segment) => segment.text)
    .join('')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

const trimLeadingSpaces = (line) => {
  while (line.length && /\s/u.test(line[0].text)) line.shift();
  return line;
};

const trimTrailingSpaces = (line) => {
  while (line.length && /\s/u.test(line.at(-1).text)) line.pop();
  return line;
};

const wrapSegmentsByWidth = (segments, maxWidth, fontSize = theme.text.bodySize) => {
  const lines = [];
  let line = [];
  let width = 0;

  for (const segment of segments) {
    if (segment.text === '\n') {
      lines.push(trimTrailingSpaces(line));
      line = [];
      width = 0;
      continue;
    }

    const segmentPixelWidth = segmentWidth(segment, fontSize);
    if (width + segmentPixelWidth > maxWidth && line.length) {
      const breakIndex = line.map((item) => /\s/u.test(item.text)).lastIndexOf(true);
      if (breakIndex > 0) {
        lines.push(trimTrailingSpaces(line.slice(0, breakIndex)));
        line = trimLeadingSpaces(line.slice(breakIndex + 1));
        width = linePixelWidth(line, fontSize);
      } else {
        lines.push(line);
        line = [];
        width = 0;
      }
    }

    line.push(segment);
    width += segmentPixelWidth;
  }

  if (line.length) lines.push(trimTrailingSpaces(line));
  return lines.length ? lines : [[]];
};

const contentWidthCandidates = (segments, fontSize) => {
  const paragraphs = segments
    .reduce((items, segment) => {
      if (segment.text === '\n') items.push([]);
      else items.at(-1).push(segment);
      return items;
    }, [[]]);
  const paragraphWidths = paragraphs.map((paragraph) => linePixelWidth(paragraph, fontSize));
  const rawWidth = Math.max(...paragraphWidths, 0);
  const hasLongToken = paragraphs.some((paragraph, index) =>
    paragraphWidths[index] > theme.text.maxContentWidth && !paragraph.some((segment) => /\s/u.test(segment.text))
  );
  if (hasLongToken) return [theme.text.maxContentWidth];

  const maxWidth = Math.min(theme.text.maxContentWidth, Math.max(theme.text.minContentWidth, Math.ceil(rawWidth)));
  const minWidth = Math.min(maxWidth, Math.max(theme.text.minContentWidth, Math.ceil(maxWidth * 0.54)));
  const widths = [];
  for (let width = minWidth; width <= maxWidth; width += theme.text.widthStep) widths.push(width);
  if (!widths.includes(maxWidth)) widths.push(maxWidth);
  return widths;
};

const lineLayoutScore = (lines, width, fontSize) => {
  const widths = lines.map((line) => linePixelWidth(line, fontSize));
  const fullest = Math.max(...widths, 0);
  const emptyRight = widths.reduce((total, lineWidth) => total + Math.max(0, width - lineWidth), 0) / Math.max(1, lines.length);
  const raggedness = widths.reduce((total, lineWidth) => total + Math.abs(fullest - lineWidth), 0) / Math.max(1, lines.length);
  const lastLineWaste = Math.max(0, width - (widths.at(-1) || 0));
  const shortInteriorLines = widths
    .slice(0, -1)
    .reduce((total, lineWidth) => total + Math.max(0, width * 0.7 - lineWidth), 0);
  const awkwardShortWordBreaks = lines.slice(0, -1).reduce((total, line, index) => {
    const currentWords = lineWords(line);
    const nextWords = lineWords(lines[index + 1]);
    const lastWord = currentWords.at(-1) || '';
    const nextWord = nextWords[0] || '';
    const startsWithShortWord = nextWord.length > 0 && nextWord.length <= 3;
    const splitsShortPair = lastWord.length > 0 && lastWord.length <= 4 && startsWithShortWord;
    return total + (startsWithShortWord ? fontSize * 3 : 0) + (splitsShortPair ? fontSize * 8 : 0);
  }, 0);
  const overflow = widths.some((lineWidth) => lineWidth > width + 0.5) ? 10000 : 0;
  return overflow + emptyRight * 0.7 + raggedness * 0.35 + shortInteriorLines * 1.4 + awkwardShortWordBreaks + lastLineWaste * 0.25 + lines.length * fontSize * 0.2 + width * 0.03;
};

const chooseTextLayout = (segments) => {
  const fontSizes = theme.text.fontSizes || [theme.text.bodySize];
  let best = null;

  for (const fontSize of fontSizes) {
    const lineHeight = Math.ceil(fontSize * 1.2);
    for (const width of contentWidthCandidates(segments, fontSize)) {
      const lines = wrapSegmentsByWidth(segments, width, fontSize);
      const textWidth = Math.ceil(Math.max(...lines.map((line) => linePixelWidth(line, fontSize)), 0));
      const score = lineLayoutScore(lines, width, fontSize);
      const contentWidth = Math.min(theme.text.maxContentWidth, Math.max(theme.text.minContentWidth, textWidth + theme.text.widthSafety));
      if (!best || score < best.score) best = { lines, fontSize, lineHeight, width: textWidth, contentWidth, score };
    }
  }

  return best || {
    lines: [[]],
    fontSize: theme.text.bodySize,
    lineHeight: theme.text.bodyLineHeight,
    width: theme.text.minContentWidth,
    contentWidth: theme.text.minContentWidth
  };
};

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

const textLineWidth = (line, fontSize = theme.text.bodySize) =>
  Math.ceil(linePixelWidth(line, fontSize));

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

const lineElements = async (line, fontSize = theme.text.bodySize) => {
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
            width: Math.ceil(fontSize * 1.12),
            height: Math.ceil(fontSize * 1.12),
            margin: '0 2px',
            objectFit: 'contain'
          }
        });
      }
    }

    return el('span', {
      key: index,
      style: {
        fontWeight: segment.bold ? 800 : 400,
        fontStyle: segment.italic ? 'italic' : 'normal',
        textDecoration: segment.underline ? 'underline' : segment.strike ? 'line-through' : 'none',
        fontFamily: 'Noto Sans Quote',
        whiteSpace: 'pre'
      }
    }, visibleText(segment.text));
  }));
};

const senderKey = (message) => {
  const user = quoteUser(message);
  return user?.id || user?.username || userName(user);
};

const senderGroupFor = (messages, index) => {
  const senderId = senderKey(messages[index]);
  let start = index;
  let end = index;
  while (start > 0 && senderKey(messages[start - 1]) === senderId) start -= 1;
  while (end < messages.length - 1 && senderKey(messages[end + 1]) === senderId) end += 1;
  return messages.slice(start, end + 1);
};

const textAvatarSize = (messages) => {
  const textMessages = messages.filter((message) => segmentsWithEntities(message).length > 0);
  const lineCount = textMessages.reduce((total, message) => total + chooseTextLayout(segmentsWithEntities(message)).lines.length, 0);
  const charCount = textMessages.reduce((total, message) => total + (message.text || message.caption || '').length, 0);

  if (lineCount >= 8 || charCount > 180) return theme.avatar.dense;
  if (lineCount >= 6 || charCount > 120) return theme.avatar.paragraph;
  if (messages.length > 1) return theme.avatar.groupedText;
  if (lineCount <= 2 && charCount <= 24) return theme.avatar.largeText;
  return theme.avatar.normalText;
};

const bestPhotoFileId = (message) => {
  const photos = message.photo || [];
  return photos[photos.length - 1]?.file_id;
};

const fitSize = (width, height, maxWidth = theme.media.maxWidth, maxHeight = theme.media.maxHeight) => {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

const mediaFile = (message) => {
  if (bestPhotoFileId(message)) return { fileId: bestPhotoFileId(message), format: 'jpeg' };
  if (message.sticker?.file_id && !message.sticker.is_animated && !message.sticker.is_video) {
    return { fileId: message.sticker.file_id, format: 'png' };
  }
  if (message.sticker?.thumbnail?.file_id) return { fileId: message.sticker.thumbnail.file_id, format: 'png' };
  if (message.video_note?.thumbnail?.file_id) return { fileId: message.video_note.thumbnail.file_id, format: 'jpeg', circle: true };
  if (message.video?.thumbnail?.file_id) return { fileId: message.video.thumbnail.file_id, format: 'jpeg' };
  return null;
};

const fallbackSegments = (message) => {
  if (message.video_note) return plainSegments('video message');
  if (message.video) return plainSegments('video');
  if (message.sticker) return plainSegments('sticker');
  return [];
};

const bubbleRadius = (role) => {
  if (role === 'top') return '28px 28px 28px 10px';
  if (role === 'middle') return '10px 18px 18px 10px';
  if (role === 'bottom') return '10px 28px 28px 0';
  return '28px 28px 28px 0';
};

const bubbleShapeUri = (width, height, role) => {
  const tail = theme.layout.tailWidth;
  const topLeft = role === 'bottom' ? 10 : 28;
  const topRight = 28;
  const bottomRight = 28;
  const fullWidth = width + tail;
  const x = tail;
  const right = fullWidth;
  const path = [
    `M${x + topLeft} 0`,
    `H${right - topRight}`,
    `Q${right} 0 ${right} ${topRight}`,
    `V${height - bottomRight}`,
    `Q${right} ${height} ${right - bottomRight} ${height}`,
    `H0`,
    `C15 ${height} ${x} ${height - 13} ${x} ${height - tail}`,
    `V${topLeft}`,
    `Q${x} 0 ${x + topLeft} 0`,
    'Z'
  ].join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fullWidth}" height="${height}" viewBox="0 0 ${fullWidth} ${height}"><path fill="${theme.background}" d="${path}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

const bubbleTailUri = (height) => {
  const tail = theme.layout.tailWidth;
  const path = [
    `M${tail} ${height - tail}`,
    `V${height}`,
    'H0',
    `C15 ${height} ${tail} ${height - 13} ${tail} ${height - tail}`,
    'Z'
  ].join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tail}" height="${height}" viewBox="0 0 ${tail} ${height}"><path fill="${theme.background}" d="${path}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

const buildAvatar = (avatar, user, color, size, top) => {
  if (avatar) {
    return el('img', {
      src: avatar,
      style: {
        position: 'absolute',
        left: theme.layout.leftPadding,
        top,
        width: size,
        height: size,
        borderRadius: size / 2,
        objectFit: 'cover'
      }
    });
  }

  return el('div', {
    style: {
      position: 'absolute',
      left: theme.layout.leftPadding,
      top,
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: color,
      color: '#ffffff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size > 100 ? 62 : 42,
      fontWeight: 800
    }
  }, initials(user));
};

export const createQuoteRenderer = ({ api, downloadTelegramFile }) => {
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

  const mediaDataUri = async (message) => {
    const media = mediaFile(message);
    if (!media) return null;

    const buffer = await downloadTelegramFile(media.fileId);
    const metadata = await sharp(buffer).metadata();
    const baseWidth = metadata.width || 636;
    const baseHeight = metadata.height || 420;
    const size = media.circle
      ? { width: theme.media.circleSize, height: theme.media.circleSize }
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

  const quoteTree = async (messages) => {
    const blocks = [];
    let y = theme.layout.topPadding;
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
      const senderGroup = senderGroupFor(messages, index);
      const role = firstInGroup && lastInGroup ? 'single' : firstInGroup ? 'top' : lastInGroup ? 'bottom' : 'middle';
      const continuation = !firstInGroup;
      const renderAvatar = lastInGroup;
      const avatar = renderAvatar ? await avatarDataUri(user) : null;
      const media = await mediaDataUri(message);
      const textSegments = segmentsWithEntities(message);
      const hasText = textSegments.length > 0;
      const mediaOnly = Boolean(media && !hasText);
      const textLayout = hasText
        ? chooseTextLayout(textSegments)
        : media ? null : chooseTextLayout(fallbackSegments(message));
      const lines = textLayout?.lines || [];
      const nameElements = await lineElements(plainSegments(name));
      const bodyFontSize = textLayout?.fontSize || theme.text.bodySize;
      const bodyLineHeight = textLayout?.lineHeight || theme.text.bodyLineHeight;
      const bodyLineElements = await Promise.all(lines.map((line) => lineElements(line, bodyFontSize)));
      const nameWidth = Math.min(520, Math.ceil(Array.from(name).length * theme.text.nameSize * 0.54));
      const textWidth = textLayout?.width || 0;
      const minTextWidth = theme.text.minBubbleWidth;
      const contentWidth = Math.max(minTextWidth, nameWidth, textLayout?.contentWidth || textWidth, media?.width || 0);
      const bubbleWidth = mediaOnly
        ? Math.max(media.width + (media?.circle ? theme.media.circleInset : 0) * 2, continuation ? 180 : nameWidth + 72)
        : Math.min(840, contentWidth + 48);
      const displayMediaWidth = mediaOnly && !media?.circle ? bubbleWidth : media?.width;
      const displayMediaHeight = mediaOnly && media
        ? media.circle ? media.height : Math.round(media.height * (bubbleWidth / media.width))
        : media?.height;
      const textHeight = lines.length * bodyLineHeight;
      const mediaHeight = displayMediaHeight || 0;
      const headerHeight = continuation ? 0 : 18 + theme.text.nameLineHeight + 8;
      const contentHeight = (continuation ? 10 : 18) + (continuation ? 0 : theme.text.nameLineHeight) + (continuation ? 0 : 8) + textHeight + (media ? 14 + mediaHeight : 0) + (continuation ? 10 : 20);
      const mediaTopGap = mediaOnly ? continuation ? 0 : 8 : 14;
      const mediaOnlyHeight = headerHeight + mediaTopGap + mediaHeight;
      const bubbleHeight = mediaOnly ? mediaOnlyHeight : messages.length > 1 ? contentHeight : Math.max(104, contentHeight);
      const avatarSize = mediaOnly ? media?.circle ? theme.avatar.circleMedia : theme.avatar.media : textAvatarSize(senderGroup);
      const bubbleLeft = theme.layout.leftPadding + avatarSize + theme.layout.tailWidth - theme.layout.tailOverlap;
      const avatarTop = renderAvatar ? bubbleHeight - avatarSize : 0;
      if (renderAvatar && y + avatarTop < theme.layout.topPadding) y += theme.layout.topPadding - (y + avatarTop);
      canvasWidth = Math.max(canvasWidth, bubbleLeft + bubbleWidth + theme.layout.leftPadding);

      blocks.push(el('div', {
        key: message.message_id,
        style: {
          position: 'absolute',
          left: 0,
          top: y,
          width: bubbleLeft + bubbleWidth + theme.layout.leftPadding,
          height: bubbleHeight,
          display: 'flex'
        }
      },
        renderAvatar ? buildAvatar(avatar, user, color, avatarSize, avatarTop) : null,
        renderAvatar ? el('img', {
          src: mediaOnly ? bubbleShapeUri(bubbleWidth, bubbleHeight, role) : bubbleTailUri(bubbleHeight),
          style: {
            position: 'absolute',
            left: bubbleLeft - theme.layout.tailWidth,
            top: 0,
            width: mediaOnly ? bubbleWidth + theme.layout.tailWidth : theme.layout.tailWidth,
            height: bubbleHeight
          }
        }) : null,
        el('div', {
          style: {
            position: 'absolute',
            left: bubbleLeft,
            top: 0,
            ...(mediaOnly ? { width: bubbleWidth } : { maxWidth: theme.text.maxContentWidth + 48 }),
            minHeight: bubbleHeight,
            borderRadius: bubbleRadius(role),
            backgroundColor: theme.background,
            padding: mediaOnly ? continuation ? 0 : '18px 0 0 0' : continuation ? '10px 24px 10px 24px' : '18px 24px 20px 24px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }
        },
          continuation ? null : el('div', {
            style: {
              color,
              fontSize: theme.text.nameSize,
              lineHeight: `${theme.text.nameLineHeight}px`,
              fontWeight: 800,
              marginBottom: 8,
              marginLeft: mediaOnly ? 26 : 0,
              marginRight: mediaOnly ? 26 : 0,
              fontFamily: 'Noto Sans Quote',
              display: 'flex',
              flexDirection: 'row'
            }
          }, nameElements),
          ...mediaOnly ? [] : lines.map((line, lineIndex) =>
            el('div', {
              key: lineIndex,
              style: {
                color: '#ffffff',
                fontSize: bodyFontSize,
                lineHeight: `${bodyLineHeight}px`,
                fontWeight: 400,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                fontFamily: 'Noto Sans Quote'
              }
            }, bodyLineElements[lineIndex])
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
      y += bubbleHeight + (sameNext ? theme.layout.sameSenderGap : theme.layout.senderGap);
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

  const quoteImage = async (messages) =>
    sharp(await renderQuoteSvg(messages))
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } });

  const renderQuotePng = async (messages) =>
    (await quoteImage(messages)).png().toBuffer();

  const renderStickerWebp = async (messages) => {
    const resized = await (await quoteImage(messages))
      .resize({ width: 512, height: 430, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const { width = 512, height = 430 } = await sharp(resized).metadata();
    const horizontalPadding = Math.max(0, 512 - width);
    const bottomPadding = Math.min(theme.layout.stickerFooter, Math.max(0, 512 - height));

    return sharp(resized)
      .extend({
        top: 0,
        bottom: bottomPadding,
        left: 0,
        right: horizontalPadding,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality: 88 })
      .toBuffer();
  };

  return { renderQuotePng, renderStickerWebp };
};

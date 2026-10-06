export const replyPhotoFileId = (reply) => {
  const photos = Array.isArray(reply?.photo)
    ? reply.photo.filter((photo) => photo?.file_id)
    : [];

  return photos.reduce((largest, photo) => {
    if (!largest) return photo;
    const area = Number(photo.width || 0) * Number(photo.height || 0);
    const largestArea = Number(largest.width || 0) * Number(largest.height || 0);
    return area > largestArea ? photo : largest;
  }, null)?.file_id;
};

export const staticStickerInput = (sticker, emoji = '💬') => ({
  sticker,
  emoji_list: [emoji],
  format: 'static'
});

const isMissingSet = (error) =>
  /sticker set not found|stickerset_invalid|stickers? set .* not found/i.test(error?.message || '');
const isFullSet = (error) => /STICKERS_TOO_MUCH/i.test(error?.message || '');
const isOccupiedName = (error) => /STICKERSET_NAME_OCCUPIED/i.test(error?.message || '');

export const stickerPackName = (baseName, index) => {
  const match = String(baseName || '').match(/^([a-z][a-z0-9_]*)(_by_[a-z0-9_]+)$/i);
  if (!match || baseName.length > 64 || baseName.includes('__')) {
    const error = new Error('Некорректное имя стикерпака: нужно имя до 64 символов с окончанием _by_<bot_username>.');
    error.code = 400;
    throw error;
  }
  if (index === 1) return baseName;
  const number = `_${index}`;
  const prefixLength = 64 - number.length - match[2].length;
  if (prefixLength < 1) {
    const error = new Error('Имя бота слишком длинное для следующего стикерпака.');
    error.code = 400;
    throw error;
  }
  return `${match[1].slice(0, prefixLength).replace(/_+$/, '')}${number}${match[2]}`;
};

const packTitle = (title, index) => {
  const suffix = index === 1 ? '' : ` #${index}`;
  return `${Array.from(title || 'Group Quotes').slice(0, 64 - suffix.length).join('')}${suffix}`;
};

export const isRetryableStickerError = (error) =>
  !Number(error?.code) || Number(error.code) === 429 || Number(error.code) >= 500;

export const stickerSaveErrorText = (error) => {
  if (/USER_ID_INVALID|PEER_ID_INVALID|STICKERSET_OWNER|not enough rights|forbidden/i.test(error?.message || '')) {
    return 'Не хватает прав на стикерпак. Владелец набора должен открыть бота в личке и нажать Start; админу нужно проверить владельца набора.';
  }
  if (/STICKER.*INVALID|STICKER.*DIMENSIONS|STICKER.*TOO_BIG/i.test(error?.message || '')) {
    return 'Telegram не принял этот стикер. Попробуй другое фото или статический стикер из /q.';
  }
  return 'Не смог сохранить стикер. Попроси админа проверить настройки группового стикерпака.';
};

export const createStickerService = ({ api, setName, setTitle = 'Group Quotes' } = {}) => {
  let index = 1;
  let pending = Promise.resolve();

  const saveInner = async ({ ownerUserId, fileId, fileUniqueId }) => {
    const sticker = staticStickerInput(fileId);
    let creationConflicts = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = stickerPackName(setName, index);
      let set;
      try {
        set = await api('getStickerSet', { name });
      } catch (error) {
        if (!isMissingSet(error)) throw error;
      }

      if (set) {
        if (set.stickers.some((item) => item.file_id === fileId ||
          (fileUniqueId && item.file_unique_id === fileUniqueId))) {
          return { name, alreadySaved: true };
        }
        if (set.stickers.length >= 120) {
          index += 1;
          continue;
        }
        try {
          await api('addStickerToSet', { user_id: ownerUserId, name, sticker });
          return { name, alreadySaved: false };
        } catch (error) {
          if (isFullSet(error)) {
            index += 1;
            continue;
          }
          if (!isMissingSet(error)) throw error;
        }
      }

      try {
        await api('createNewStickerSet', {
          user_id: ownerUserId,
          name,
          title: packTitle(setTitle, index),
          stickers: [sticker]
        });
        return { name, alreadySaved: false };
      } catch (error) {
        // Another replica may have created the same pack after getStickerSet.
        if (!isOccupiedName(error) || creationConflicts >= 2) throw error;
        creationConflicts += 1;
      }
    }
    const error = new Error('Не удалось найти свободный стикерпак после 100 проверок.');
    error.code = 400;
    throw error;
  };

  const save = (input) => {
    const result = pending.then(() => saveInner(input));
    pending = result.catch(() => {});
    return result;
  };

  return { save };
};

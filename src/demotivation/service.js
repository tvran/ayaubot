export const maxDemotivationTextLength = 100;

export const normalizeDemotivationText = (value = '') =>
  String(value).replace(/\s+/gu, ' ').trim();

export const demotivationFontSize = (text) => {
  const length = Array.from(text).length;
  if (length <= 22) return 84;
  if (length <= 45) return 68;
  if (length <= 75) return 54;
  return 42;
};

export const replyImageFileId = (reply) => {
  if (reply?.photo?.length) {
    return reply.photo.reduce((largest, current) => {
      const largestArea = Number(largest.width || 0) * Number(largest.height || 0);
      const currentArea = Number(current.width || 0) * Number(current.height || 0);
      return currentArea >= largestArea ? current : largest;
    }).file_id;
  }

  if (reply?.document?.file_id && /^image\//i.test(reply.document.mime_type || '')) {
    return reply.document.file_id;
  }

  if (reply?.sticker?.file_id && !reply.sticker.is_animated && !reply.sticker.is_video) {
    return reply.sticker.file_id;
  }

  return null;
};

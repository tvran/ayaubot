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

export const replyDemotivationSource = (reply) => {
  if (reply?.photo?.length) {
    const photo = reply.photo.reduce((largest, current) => {
      const largestArea = Number(largest.width || 0) * Number(largest.height || 0);
      const currentArea = Number(current.width || 0) * Number(current.height || 0);
      return currentArea >= largestArea ? current : largest;
    });
    return { fileId: photo.file_id, kind: 'image' };
  }

  if (reply?.document?.file_id && /^image\//i.test(reply.document.mime_type || '')) {
    return { fileId: reply.document.file_id, kind: 'image' };
  }

  if (reply?.sticker?.file_id && !reply.sticker.is_animated && !reply.sticker.is_video) {
    return { fileId: reply.sticker.file_id, kind: 'image' };
  }

  if (reply?.video_note?.file_id) {
    return { fileId: reply.video_note.file_id, kind: 'video_note' };
  }

  return null;
};

export const replyImageFileId = (reply) => {
  const source = replyDemotivationSource(reply);
  return source?.kind === 'image' ? source.fileId : null;
};

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

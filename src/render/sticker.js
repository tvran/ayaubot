import sharp from 'sharp';

export const maxStaticStickerBytes = 512 * 1024;

const webpQualities = [90, 80, 70, 60, 50];

export const createStickerRenderer = () => ({
  renderPhotoWebp: async (imageBuffer) => {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new TypeError('Sticker source must be a non-empty Buffer');
    }

    for (const quality of webpQualities) {
      const sticker = await sharp(imageBuffer)
        .rotate()
        .resize({
          width: 512,
          height: 512,
          fit: 'inside',
          withoutEnlargement: false
        })
        .webp({ quality, effort: 6, smartSubsample: true })
        .toBuffer();

      if (sticker.length <= maxStaticStickerBytes) return sticker;
    }

    const error = new Error('Static sticker exceeds Telegram file size limit');
    error.code = 'sticker_too_large';
    throw error;
  }
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';
import { demotivationFontSize } from '../demotivation/service.js';

const boldFont = readFileSync(join(process.cwd(), 'assets/fonts/NotoSans-Bold.ttf'));

const canvas = { width: 1084, height: 1200 };
const frame = {
  left: 80,
  top: 76,
  width: 920,
  height: 888,
  border: 6
};
const image = {
  left: frame.left + frame.border,
  top: frame.top + frame.border,
  width: frame.width - frame.border * 2,
  height: frame.height - frame.border * 2
};

const element = (type, style, children) => ({
  type,
  props: { style, children }
});

const template = (text) => element('div', {
  position: 'relative',
  display: 'flex',
  width: '100%',
  height: '100%',
  backgroundColor: '#000000',
  fontFamily: 'Noto Sans'
}, [
  element('div', {
    position: 'absolute',
    display: 'flex',
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    border: `${frame.border}px solid #ffffff`,
    boxSizing: 'border-box'
  }),
  element('div', {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    left: 62,
    top: 1008,
    width: 960,
    height: 170,
    color: '#ffffff',
    fontSize: demotivationFontSize(text),
    fontWeight: 700,
    letterSpacing: '-2px',
    lineHeight: 1.05,
    textAlign: 'center',
    wordBreak: 'break-all',
    overflow: 'hidden'
  }, text)
]);

export const createDemotivationRenderer = () => ({
  async renderJpeg(imageBuffer, text) {
    if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
      throw new TypeError('imageBuffer must be a non-empty Buffer');
    }

    const [svg, stretchedImage] = await Promise.all([
      satori(template(text), {
        ...canvas,
        fonts: [{ name: 'Noto Sans', data: boldFont, weight: 700, style: 'normal' }]
      }),
      sharp(imageBuffer)
        .rotate()
        .resize(image.width, image.height, { fit: 'fill' })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toBuffer()
    ]);

    return sharp(Buffer.from(svg))
      .composite([{ input: stretchedImage, left: image.left, top: image.top }])
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }
});

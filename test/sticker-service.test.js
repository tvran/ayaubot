import assert from 'node:assert/strict';
import test from 'node:test';

import { replyPhotoFileId, staticStickerInput } from '../src/sticker/service.js';

test('replyPhotoFileId selects the largest Telegram photo variant', () => {
  const reply = {
    photo: [
      { file_id: 'medium', width: 640, height: 480 },
      { file_id: 'small', width: 160, height: 120 },
      { file_id: 'large', width: 1280, height: 960 }
    ]
  };

  assert.equal(replyPhotoFileId(reply), 'large');
});

test('replyPhotoFileId accepts only Telegram photo replies', () => {
  assert.equal(replyPhotoFileId(), undefined);
  assert.equal(replyPhotoFileId({ photo: [] }), undefined);
  assert.equal(replyPhotoFileId({ document: { file_id: 'image-document' } }), undefined);
  assert.equal(replyPhotoFileId({ sticker: { file_id: 'sticker' } }), undefined);
});

test('staticStickerInput references an uploaded Telegram file without multipart nesting', () => {
  assert.deepEqual(staticStickerInput('telegram-file-id'), {
    sticker: 'telegram-file-id',
    emoji_list: ['💬'],
    format: 'static'
  });
});

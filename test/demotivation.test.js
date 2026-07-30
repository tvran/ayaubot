import assert from 'node:assert/strict';
import test from 'node:test';
import {
  demotivationFontSize,
  normalizeDemotivationText,
  replyImageFileId
} from '../src/demotivation/service.js';

test('normalizes demotivation text and scales font by its length', () => {
  assert.equal(normalizeDemotivationText('  Хьюстон,\n  у нас проблемы  '), 'Хьюстон, у нас проблемы');
  assert.equal(demotivationFontSize('Коротко'), 84);
  assert.equal(demotivationFontSize('а'.repeat(30)), 68);
  assert.equal(demotivationFontSize('а'.repeat(60)), 54);
  assert.equal(demotivationFontSize('а'.repeat(90)), 42);
});

test('selects the largest replied photo independent of Telegram array order', () => {
  assert.equal(replyImageFileId({
    photo: [
      { file_id: 'medium', width: 800, height: 600 },
      { file_id: 'small', width: 320, height: 240 },
      { file_id: 'large', width: 1280, height: 960 }
    ]
  }), 'large');
});

test('accepts image documents and static stickers only', () => {
  assert.equal(replyImageFileId({ document: { file_id: 'image', mime_type: 'image/png' } }), 'image');
  assert.equal(replyImageFileId({ document: { file_id: 'pdf', mime_type: 'application/pdf' } }), null);
  assert.equal(replyImageFileId({ sticker: { file_id: 'static' } }), 'static');
  assert.equal(replyImageFileId({ sticker: { file_id: 'animated', is_animated: true } }), null);
  assert.equal(replyImageFileId({ sticker: { file_id: 'video', is_video: true } }), null);
  assert.equal(replyImageFileId(null), null);
});

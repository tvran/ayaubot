import assert from 'node:assert/strict';
import test from 'node:test';

import { createStickerService, replyPhotoFileId, staticStickerInput, stickerPackName } from '../src/sticker/service.js';

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

const baseName = 'quotes_by_TestBot';
const fullSet = () => Array.from({ length: 120 }, (_, i) => ({ file_id: `old-${i}` }));
const telegramError = (message, code = 400) => Object.assign(new Error(message), { code });

const fakeTelegram = (initial = {}) => {
  const sets = new Map(Object.entries(initial));
  const calls = [];
  const api = async (method, payload) => {
    calls.push({ method, payload });
    const stickers = sets.get(payload.name);
    if (method === 'getStickerSet') {
      if (!stickers) throw telegramError('Bad Request: STICKERSET_INVALID');
      return { name: payload.name, stickers: [...stickers] };
    }
    if (method === 'createNewStickerSet') {
      if (stickers) throw telegramError('Bad Request: STICKERSET_NAME_OCCUPIED');
      sets.set(payload.name, payload.stickers.map((item) => ({ file_id: item.sticker })));
      return true;
    }
    if (method === 'addStickerToSet') {
      if (stickers.length >= 120) throw telegramError('Bad Request: STICKERS_TOO_MUCH');
      stickers.push({ file_id: payload.sticker.sticker });
      return true;
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  return { api, sets, calls };
};

test('a full pack rolls over to a numbered pack without deleting old stickers', async () => {
  const telegram = fakeTelegram({ [baseName]: fullSet() });
  const service = createStickerService({ api: telegram.api, setName: baseName, setTitle: 'Quotes' });
  assert.deepEqual(await service.save({ ownerUserId: 7, fileId: 'new' }), {
    name: 'quotes_2_by_TestBot', alreadySaved: false
  });
  assert.equal(telegram.sets.get(baseName).length, 120);
  assert.deepEqual(telegram.sets.get('quotes_2_by_TestBot'), [{ file_id: 'new' }]);
  const creation = telegram.calls.find((call) => call.method === 'createNewStickerSet');
  assert.equal(creation.payload.title, 'Quotes #2');
  assert.equal(creation.payload.user_id, 7);
});

test('restart discovers existing numbered packs and repeats do not add duplicate stickers', async () => {
  const telegram = fakeTelegram({
    [baseName]: fullSet(),
    quotes_2_by_TestBot: fullSet(),
    quotes_3_by_TestBot: [{ file_id: 'old-reference', file_unique_id: 'unique' }]
  });
  const service = createStickerService({ api: telegram.api, setName: baseName });
  const result = await service.save({ ownerUserId: 7, fileId: 'new-reference', fileUniqueId: 'unique' });
  assert.deepEqual(result, { name: 'quotes_3_by_TestBot', alreadySaved: true });
  assert.equal(telegram.calls.some((call) => call.method !== 'getStickerSet'), false);
  await service.save({ ownerUserId: 7, fileId: 'another' });
  assert.equal(telegram.sets.get('quotes_3_by_TestBot').length, 2);
});

test('an existing sticker in a full pack is returned before rollover', async () => {
  const telegram = fakeTelegram({ [baseName]: fullSet() });
  const service = createStickerService({ api: telegram.api, setName: baseName });
  assert.deepEqual(await service.save({ ownerUserId: 7, fileId: 'old-0' }), { name: baseName, alreadySaved: true });
  assert.equal(telegram.sets.size, 1);
});

test('STICKERS_TOO_MUCH from addStickerToSet also rolls over after a capacity race', async () => {
  const telegram = fakeTelegram({ [baseName]: fullSet().slice(0, 119) });
  const service = createStickerService({ setName: baseName, api: async (method, payload) => {
    if (method === 'addStickerToSet' && payload.name === baseName) {
      throw telegramError('Bad Request: STICKERS_TOO_MUCH');
    }
    return telegram.api(method, payload);
  } });
  assert.equal((await service.save({ ownerUserId: 7, fileId: 'new' })).name, 'quotes_2_by_TestBot');
});

test('concurrent creation by another replica is recovered by reading the same pack', async () => {
  const telegram = fakeTelegram();
  let raced = false;
  const service = createStickerService({ setName: baseName, api: async (method, payload) => {
    if (method === 'createNewStickerSet' && !raced) {
      raced = true;
      telegram.sets.set(baseName, [{ file_id: 'other' }]);
      throw telegramError('Bad Request: STICKERSET_NAME_OCCUPIED');
    }
    return telegram.api(method, payload);
  } });
  assert.equal((await service.save({ ownerUserId: 7, fileId: 'new' })).name, baseName);
  assert.deepEqual(telegram.sets.get(baseName).map((item) => item.file_id), ['other', 'new']);
});

test('simultaneous saves are serialized across the last free slot and rollover', async () => {
  const telegram = fakeTelegram({ [baseName]: fullSet().slice(0, 119) });
  const service = createStickerService({ api: telegram.api, setName: baseName });
  const results = await Promise.all(['one', 'two', 'two'].map((fileId) => service.save({ ownerUserId: 7, fileId })));
  assert.deepEqual(results.map((item) => item.name), [baseName, 'quotes_2_by_TestBot', 'quotes_2_by_TestBot']);
  assert.equal(results[2].alreadySaved, true);
  assert.equal(telegram.sets.get(baseName).length, 120);
  assert.equal(telegram.sets.get('quotes_2_by_TestBot').length, 1);
});

test('permission errors do not create new packs and failed saves do not poison later saves', async () => {
  const telegram = fakeTelegram({ [baseName]: [] });
  let denied = true;
  const service = createStickerService({ setName: baseName, api: async (method, payload) => {
    if (method === 'addStickerToSet' && denied) throw telegramError('Bad Request: USER_ID_INVALID');
    return telegram.api(method, payload);
  } });
  await assert.rejects(service.save({ ownerUserId: 7, fileId: 'one' }), /USER_ID_INVALID/);
  denied = false;
  await service.save({ ownerUserId: 7, fileId: 'two' });
  assert.equal(telegram.sets.size, 1);
  assert.deepEqual(telegram.sets.get(baseName), [{ file_id: 'two' }]);
});

test('numbered names retain the Telegram bot suffix and the 64-character limit', () => {
  const longName = `${'a'.repeat(52)}_by_TestBot`;
  const name = stickerPackName(longName, 12);
  assert.equal(name.length, 64);
  assert.match(name, /_12_by_TestBot$/);
  assert.equal(name.includes('__'), false);
  assert.throws(() => stickerPackName('wrong_name', 2), /Некорректное имя/);
});

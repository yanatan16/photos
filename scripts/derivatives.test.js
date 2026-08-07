import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import exifr from 'exifr';
import { makeThumbnail, makeWebSized, THUMBNAIL_WIDTH, WEB_WIDTH } from './derivatives.js';

// Generated in memory rather than read from disk, so the suite stays pure.
const sourcePhoto = ({ width = 4000, height = 3000 } = {}) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .withExif({ IFD0: { Make: 'FUJIFILM', Model: 'X-T5' } })
    .jpeg()
    .toBuffer();

test('makeWebSized resizes to the web width', async () => {
  const web = await makeWebSized(await sourcePhoto());
  const { width, format } = await sharp(web).metadata();

  assert.equal(width, WEB_WIDTH);
  assert.equal(format, 'jpeg');
});

test('makeThumbnail resizes to the thumbnail width', async () => {
  const thumbnail = await makeThumbnail(await sourcePhoto());
  const { width, format } = await sharp(thumbnail).metadata();

  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(format, 'jpeg');
});

test('makeWebSized preserves EXIF — it is the only metadata copy for a deferred original', async () => {
  const web = await makeWebSized(await sourcePhoto());
  const exif = await exifr.parse(web, { pick: ['Make', 'Model'] });

  assert.equal(exif.Make, 'FUJIFILM');
  assert.equal(exif.Model, 'X-T5');
});

test('makeThumbnail drops EXIF', async () => {
  const thumbnail = await makeThumbnail(await sourcePhoto());

  assert.equal(await exifr.parse(thumbnail, { pick: ['Make'] }), undefined);
});

test('neither derivative enlarges a photo smaller than its target', async () => {
  const small = await sourcePhoto({ width: 400, height: 300 });

  assert.equal((await sharp(await makeWebSized(small)).metadata()).width, 400);
  assert.equal((await sharp(await makeThumbnail(small)).metadata()).width, 400);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseExif } from './exif.js';

// Generated in memory rather than read from disk, so the suite stays pure —
// the same approach derivatives.test.js takes.
const photoWithExif = (exif) =>
  sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .withExif(exif)
    .jpeg()
    .toBuffer();

const shotOn = (overrides = {}) => photoWithExif({
  IFD0: { Make: 'FUJIFILM', Model: 'X-T5' },
  IFD2: {
    FNumber: '2.8',
    ExposureTime: '0.004',
    ISOSpeedRatings: '400',
    FocalLength: '23',
    DateTimeOriginal: '2026:03:14 09:26:53',
    LensModel: 'XF23mmF1.4 R',
    ...overrides,
  },
});

// ── the happy path ────────────────────────────────────────────────────────────

test('parseExif reads a full frame of camera settings', async () => {
  const exif = await parseExif(await shotOn());

  assert.equal(exif.camera, 'FUJIFILM X-T5');
  assert.equal(exif.lens, 'XF23mmF1.4 R');
  assert.equal(exif.aperture, 'f/2.8');
  assert.equal(exif.iso, 'ISO 400');
  assert.equal(exif.focalLength, '23mm');
});

// ── formatting ────────────────────────────────────────────────────────────────

test('parseExif renders a sub-second exposure as a reciprocal', async () => {
  assert.equal((await parseExif(await shotOn({ ExposureTime: '0.004' }))).shutter, '1/250s');
});

test('parseExif renders a long exposure in whole seconds', async () => {
  assert.equal((await parseExif(await shotOn({ ExposureTime: '30' }))).shutter, '30s');
});

test('parseExif rounds focal length to the nearest millimetre', async () => {
  assert.equal((await parseExif(await shotOn({ FocalLength: '56.4' }))).focalLength, '56mm');
});

// EXIF timestamps carry no zone, so exifr reads them as local time. Asserting
// the local hour keeps this test honest in any TZ the suite happens to run in.
test('parseExif returns dateTaken as an ISO string at the captured local time', async () => {
  const { dateTaken } = await parseExif(await shotOn());

  assert.match(dateTaken, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(dateTaken).getHours(), 9);
});

// ── partial and absent metadata ───────────────────────────────────────────────

test('parseExif keeps the make when the model is missing', async () => {
  const exif = await parseExif(await photoWithExif({ IFD0: { Make: 'FUJIFILM' } }));

  assert.equal(exif.camera, 'FUJIFILM');
});

test('parseExif nulls the fields a photo does not carry', async () => {
  const exif = await parseExif(await photoWithExif({ IFD0: { Make: 'FUJIFILM' } }));

  assert.equal(exif.lens, null);
  assert.equal(exif.aperture, null);
  assert.equal(exif.shutter, null);
  assert.equal(exif.iso, null);
  assert.equal(exif.focalLength, null);
  assert.equal(exif.dateTaken, null);
});

// `{}` is a real answer, not a failure: upload-photos.js caches it so that
// process.js stops range-fetching a photo that has no EXIF to find.
test('parseExif returns an empty object for a photo with no EXIF at all', async () => {
  const bare = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg()
    .toBuffer();

  assert.deepEqual(await parseExif(bare), {});
});

test('parseExif returns an empty object rather than throwing on a non-image buffer', async () => {
  assert.deepEqual(await parseExif(Buffer.from('this is not a photograph')), {});
});

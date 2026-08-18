import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, exifFromResults, deploySkipReason } from './upload-photos.js';

// ── parseArgs ─────────────────────────────────────────────────────────────────

test('parseArgs splits the album from the paths', () => {
  assert.deepEqual(parseArgs(['iceland-2026', 'a.jpg', 'b.jpg']), {
    folder: 'iceland-2026',
    paths: ['a.jpg', 'b.jpg'],
    concurrency: 6,
    force: false,
    deploy: false,
  });
});

test('parseArgs accepts a single directory path', () => {
  assert.deepEqual(parseArgs(['iceland-2026', '~/Pictures/Export']).paths, ['~/Pictures/Export']);
});

test('parseArgs honours --concurrency in any position', () => {
  assert.equal(parseArgs(['--concurrency', '3', 'album', 'a.jpg']).concurrency, 3);
  assert.equal(parseArgs(['album', '--concurrency', '3', 'a.jpg']).concurrency, 3);
  assert.deepEqual(parseArgs(['album', '--concurrency', '3', 'a.jpg']).paths, ['a.jpg']);
});

test('parseArgs honours --force in any position without consuming a path', () => {
  assert.equal(parseArgs(['--force', 'album', 'a.jpg']).force, true);
  assert.equal(parseArgs(['album', '--force', 'a.jpg']).force, true);
  assert.deepEqual(parseArgs(['album', '--force', 'a.jpg']).paths, ['a.jpg']);
});

test('parseArgs combines --force and --concurrency', () => {
  const parsed = parseArgs(['--force', '--concurrency', '2', 'album', 'dir']);

  assert.equal(parsed.force, true);
  assert.equal(parsed.concurrency, 2);
  assert.deepEqual(parsed.paths, ['dir']);
});

test('parseArgs rejects a missing album or path list', () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['album']), /Usage:/);
  assert.throws(() => parseArgs(['--force', 'album']), /Usage:/);
});

test('parseArgs rejects an invalid concurrency', () => {
  assert.throws(() => parseArgs(['--concurrency', '0', 'album', 'a.jpg']), /positive integer/);
});

test('parseArgs honours --deploy in any position without consuming a path', () => {
  assert.equal(parseArgs(['--deploy', 'album', 'a.jpg']).deploy, true);
  assert.equal(parseArgs(['album', '--deploy', 'a.jpg']).deploy, true);
  assert.deepEqual(parseArgs(['album', '--deploy', 'a.jpg']).paths, ['a.jpg']);
});

test('parseArgs combines every flag at once', () => {
  const parsed = parseArgs(['--deploy', '--force', '--concurrency', '2', 'album', 'dir']);

  assert.equal(parsed.deploy, true);
  assert.equal(parsed.force, true);
  assert.equal(parsed.concurrency, 2);
  assert.deepEqual(parsed.paths, ['dir']);
});

test('parseArgs defaults deploy to off', () => {
  assert.equal(parseArgs(['album', 'a.jpg']).deploy, false);
});

test('parseArgs rejects a missing path list once --deploy is removed', () => {
  assert.throws(() => parseArgs(['--deploy', 'album']), /Usage:/);
});

// ── exifFromResults ───────────────────────────────────────────────────────────

const uploaded = (key, exif) => ({ item: { key }, value: { key, exif } });
const failed = (key) => ({ item: { key }, error: new Error('socket hang up') });

test('exifFromResults keys each uploaded photo to its metadata', () => {
  const results = [
    uploaded('iceland-2026/a.jpg', { camera: 'FUJIFILM X-T5' }),
    uploaded('iceland-2026/b.jpg', { camera: 'FUJIFILM X100V' }),
  ];

  assert.deepEqual(exifFromResults(results), {
    'iceland-2026/a.jpg': { camera: 'FUJIFILM X-T5' },
    'iceland-2026/b.jpg': { camera: 'FUJIFILM X100V' },
  });
});

// A photo whose upload failed has nothing in R2 to describe. Caching its EXIF
// would make process.js consider it done and never backfill the retry.
test('exifFromResults drops photos that failed to upload', () => {
  const results = [uploaded('a/one.jpg', { iso: 'ISO 400' }), failed('a/two.jpg')];

  assert.deepEqual(exifFromResults(results), { 'a/one.jpg': { iso: 'ISO 400' } });
});

// An EXIF-less photo caches `{}` on purpose — it stops process.js range-fetching
// a photo that has nothing to find, on every future run.
test('exifFromResults keeps an empty result for a photo with no EXIF', () => {
  assert.deepEqual(exifFromResults([uploaded('a/bare.jpg', {})]), { 'a/bare.jpg': {} });
});

test('exifFromResults returns nothing for an empty run', () => {
  assert.deepEqual(exifFromResults([]), {});
});

// ── deploySkipReason ──────────────────────────────────────────────────────────

test('deploySkipReason clears a clean run', () => {
  assert.equal(deploySkipReason({ failureCount: 0, exifSaved: true }), null);
});

test('deploySkipReason holds back a run with failed photos', () => {
  const reason = deploySkipReason({ failureCount: 2, exifSaved: true });

  assert.match(reason, /2 photo\(s\) failed/);
  assert.match(reason, /Re-run the same command/);
});

// Without EXIF, fetch-photos.js dates every photo from R2's LastModified, so
// the album publishes mis-sorted and can take the wrong cover.
test('deploySkipReason holds back a run whose EXIF never reached the cache', () => {
  const reason = deploySkipReason({ failureCount: 0, exifSaved: false });

  assert.match(reason, /EXIF was not cached/);
  assert.match(reason, /npm run process/);
});

test('deploySkipReason reports failed photos ahead of the EXIF problem', () => {
  assert.match(deploySkipReason({ failureCount: 1, exifSaved: false }), /failed/);
});

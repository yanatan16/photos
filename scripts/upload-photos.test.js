import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './upload-photos.js';

// ── parseArgs ─────────────────────────────────────────────────────────────────

test('parseArgs splits the album from the paths', () => {
  assert.deepEqual(parseArgs(['iceland-2026', 'a.jpg', 'b.jpg']), {
    folder: 'iceland-2026',
    paths: ['a.jpg', 'b.jpg'],
    concurrency: 6,
    force: false,
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

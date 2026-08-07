import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './upload-photos.js';

test('parseArgs splits the folder from the files', () => {
  assert.deepEqual(parseArgs(['iceland-2026', 'a.jpg', 'b.jpg']), {
    folder: 'iceland-2026',
    files: ['a.jpg', 'b.jpg'],
    concurrency: 6,
  });
});

test('parseArgs honours --concurrency in any position', () => {
  assert.equal(parseArgs(['--concurrency', '3', 'album', 'a.jpg']).concurrency, 3);
  assert.equal(parseArgs(['album', '--concurrency', '3', 'a.jpg']).concurrency, 3);
  assert.deepEqual(parseArgs(['album', '--concurrency', '3', 'a.jpg']).files, ['a.jpg']);
});

test('parseArgs rejects a missing folder or file list', () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['album']), /Usage:/);
});

test('parseArgs rejects an invalid concurrency', () => {
  assert.throws(() => parseArgs(['--concurrency', '0', 'album', 'a.jpg']), /positive integer/);
});

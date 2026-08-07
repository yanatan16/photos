import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailKey, webKey, originalKey, logicalPhotoKeys } from './keys.js';

test('thumbnailKey inserts .thumbnails before the filename', () => {
  assert.equal(thumbnailKey('2025-italy/a.jpg'), '2025-italy/.thumbnails/a.jpg');
});

test('webKey inserts .web before the filename', () => {
  assert.equal(webKey('2025-italy/a.jpg'), '2025-italy/.web/a.jpg');
});

test('thumbnailKey handles nested paths', () => {
  assert.equal(thumbnailKey('a/b/c.jpg'), 'a/b/.thumbnails/c.jpg');
});

test('webKey handles nested paths', () => {
  assert.equal(webKey('a/b/c.jpg'), 'a/b/.web/c.jpg');
});

// ── originalKey ───────────────────────────────────────────────────────────────

test('originalKey inverts webKey and thumbnailKey', () => {
  assert.equal(originalKey('2025-italy/.web/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey('2025-italy/.thumbnails/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey(webKey('a/b/c.jpg')), 'a/b/c.jpg');
  assert.equal(originalKey(thumbnailKey('a/b/c.jpg')), 'a/b/c.jpg');
});

test('originalKey leaves a key with no derived segment alone', () => {
  assert.equal(originalKey('2025-italy/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey('a.jpg'), 'a.jpg');
});

// ── logicalPhotoKeys ──────────────────────────────────────────────────────────

test('logicalPhotoKeys returns originals that are present in the bucket', () => {
  const keys = logicalPhotoKeys(['2025-italy/a.jpg', '2025-italy/b.png']);
  assert.deepEqual([...keys].sort(), ['2025-italy/a.jpg', '2025-italy/b.png']);
});

test('logicalPhotoKeys infers a photo from its web derivative alone', () => {
  const keys = logicalPhotoKeys(['2025-italy/.web/a.jpg']);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

test('logicalPhotoKeys does not double-count a photo that has both', () => {
  const keys = logicalPhotoKeys([
    '2025-italy/a.jpg',
    '2025-italy/.web/a.jpg',
    '2025-italy/.thumbnails/a.jpg',
  ]);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

test('logicalPhotoKeys does not invent a photo from a thumbnail alone', () => {
  assert.deepEqual([...logicalPhotoKeys(['2025-italy/.thumbnails/a.jpg'])], []);
});

test('logicalPhotoKeys ignores root files, hidden files, and non-images', () => {
  const keys = logicalPhotoKeys([
    'exif-cache.json',
    'favorites.json',
    '2025-italy/.DS_Store',
    '2025-italy/notes.txt',
    '2025-italy/a.jpg',
  ]);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

// Deliberately broader than the uploader's SUPPORTED_EXTENSIONS (Task 5): this
// discovers what is already in the bucket, including formats uploaded before
// local resizing existed.
test('logicalPhotoKeys accepts every image extension the bucket may contain', () => {
  const keys = logicalPhotoKeys([
    'a/p.jpg', 'a/p.jpeg', 'a/p.png', 'a/p.gif',
    'a/p.webp', 'a/p.avif', 'a/p.heic', 'a/p.heif', 'a/p.tif', 'a/p.tiff',
  ]);
  assert.equal(keys.size, 10);
});

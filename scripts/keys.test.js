import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailKey, webKey } from './keys.js';

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

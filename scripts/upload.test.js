import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, SUPPORTED_EXTENSIONS } from './upload.js';

test('contentTypeFor maps known image extensions', () => {
  assert.equal(contentTypeFor('/photos/a.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('/photos/a.JPEG'), 'image/jpeg');
  assert.equal(contentTypeFor('/photos/a.png'), 'image/png');
  assert.equal(contentTypeFor('/photos/a.webp'), 'image/webp');
  assert.equal(contentTypeFor('/photos/a.avif'), 'image/avif');
});

test('contentTypeFor falls back to a generic type', () => {
  assert.equal(contentTypeFor('/photos/a.xyz'), 'application/octet-stream');
});

test('SUPPORTED_EXTENSIONS excludes heic and heif — sharp here cannot decode them', () => {
  assert.equal(SUPPORTED_EXTENSIONS.has('.heic'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.heif'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.jpg'), true);
});

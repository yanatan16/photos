import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingObject } from './exifStore.js';

// loadExifCache returns `{}` only for these — every other failure throws, so a
// read blip can never be mistaken for an empty cache and overwrite the real one.
test('isMissingObject recognises an absent object', () => {
  assert.equal(isMissingObject(Object.assign(new Error(), { name: 'NoSuchKey' })), true);
  assert.equal(isMissingObject(Object.assign(new Error(), { name: 'NotFound' })), true);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true);
});

test('isMissingObject rejects failures that are not an absent object', () => {
  assert.equal(isMissingObject(Object.assign(new Error(), { name: 'AccessDenied' })), false);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 500 } }), false);
  assert.equal(isMissingObject(new Error('socket hang up')), false);
  assert.equal(isMissingObject(undefined), false);
});

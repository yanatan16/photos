import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumSlugFromKey, filenameFromKey, removeKey, clearCoverIfMatches } from './deletePhoto.js';

test('albumSlugFromKey returns the first path segment', () => {
  assert.equal(albumSlugFromKey('2025-italy/a.jpg'), '2025-italy');
});

test('filenameFromKey returns everything after the album slug', () => {
  assert.equal(filenameFromKey('2025-italy/a.jpg'), 'a.jpg');
  assert.equal(filenameFromKey('a-b/c/d.jpg'), 'c/d.jpg');
});

test('removeKey drops the matching key', () => {
  assert.deepEqual(removeKey(['x/a.jpg', 'y/b.jpg'], 'x/a.jpg'), ['y/b.jpg']);
});

test('removeKey leaves the list unchanged when key is absent', () => {
  assert.deepEqual(removeKey(['y/b.jpg'], 'x/a.jpg'), ['y/b.jpg']);
});

test('clearCoverIfMatches removes the album entry when the cover matches', () => {
  assert.deepEqual(clearCoverIfMatches({ a: 'x.jpg', b: 'y.jpg' }, 'a', 'x.jpg'), { b: 'y.jpg' });
});

test('clearCoverIfMatches returns the same object when the filename differs', () => {
  const covers = { a: 'x.jpg' };
  assert.equal(clearCoverIfMatches(covers, 'a', 'z.jpg'), covers);
});

test('clearCoverIfMatches returns the same object when the album is absent', () => {
  const covers = { a: 'x.jpg' };
  assert.equal(clearCoverIfMatches(covers, 'missing', 'x.jpg'), covers);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoriteKey, favoriteKeyFromUrl, toggleFavorite, buildFavorites } from './favorites.js';

test('favoriteKey joins album slug and filename', () => {
  assert.equal(favoriteKey('2025-italy', 'a.jpg'), '2025-italy/a.jpg');
});

test('toggleFavorite adds a missing key', () => {
  const { favorites, action } = toggleFavorite([], 'x/a.jpg');
  assert.deepEqual(favorites, ['x/a.jpg']);
  assert.equal(action, 'added');
});

test('toggleFavorite removes an existing key', () => {
  const { favorites, action } = toggleFavorite(['x/a.jpg', 'y/b.jpg'], 'x/a.jpg');
  assert.deepEqual(favorites, ['y/b.jpg']);
  assert.equal(action, 'removed');
});

test('buildFavorites selects matching photos, newest first, skips missing', () => {
  const albums = [
    { id: 'a', photos: [
      { filename: 'old.jpg', date: '2020-01-01T00:00:00.000Z' },
      { filename: 'new.jpg', date: '2024-01-01T00:00:00.000Z' },
    ] },
    { id: 'b', photos: [
      { filename: 'mid.jpg', date: '2022-01-01T00:00:00.000Z' },
    ] },
  ];
  const result = buildFavorites(albums, ['a/old.jpg', 'b/mid.jpg', 'missing/x.jpg']);
  assert.deepEqual(result.map(p => p.filename), ['mid.jpg', 'old.jpg']);
});

test('buildFavorites returns [] when there are no favorites', () => {
  const albums = [{ id: 'a', photos: [{ filename: 'x.jpg', date: null }] }];
  assert.deepEqual(buildFavorites(albums, []), []);
});

test('favoriteKeyFromUrl strips origin and leading slash', () => {
  assert.equal(
    favoriteKeyFromUrl('https://pub-abc.r2.dev/2026-boulder-winter/DSC01652.jpg'),
    '2026-boulder-winter/DSC01652.jpg'
  );
});

test('favoriteKeyFromUrl handles nested paths', () => {
  assert.equal(favoriteKeyFromUrl('https://x.example/a-b/c/d.jpg'), 'a-b/c/d.jpg');
});

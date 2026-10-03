import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latest } from './latest.js';

test('returns the first n items', () => {
  assert.deepEqual(latest([1, 2, 3, 4], 2), [1, 2]);
});

test('returns everything when n exceeds the length', () => {
  assert.deepEqual(latest([1, 2], 8), [1, 2]);
});

test('returns an empty array for an empty list or n of 0', () => {
  assert.deepEqual(latest([], 4), []);
  assert.deepEqual(latest([1, 2], 0), []);
});

test('does not mutate its input', () => {
  const items = [1, 2, 3];
  latest(items, 2);
  assert.deepEqual(items, [1, 2, 3]);
});

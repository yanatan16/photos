import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasShownToday, markShownToday } from './licenseNotice.js';

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
};

const brokenStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
};

test('not shown before anything is recorded', () => {
  assert.equal(wasShownToday(memoryStorage()), false);
});

test('shown later the same day', () => {
  const s = memoryStorage();
  markShownToday(s, new Date(2026, 9, 3, 8, 0));
  assert.equal(wasShownToday(s, new Date(2026, 9, 3, 23, 59)), true);
});

test('not shown the next day', () => {
  const s = memoryStorage();
  markShownToday(s, new Date(2026, 9, 3, 23, 59));
  assert.equal(wasShownToday(s, new Date(2026, 9, 4, 0, 1)), false);
});

test('unavailable storage never throws and means "not shown"', () => {
  assert.doesNotThrow(() => markShownToday(brokenStorage));
  assert.equal(wasShownToday(brokenStorage), false);
});

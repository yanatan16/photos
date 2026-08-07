import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatRate, formatDuration } from './format.js';

test('formatBytes renders bytes below 1 KB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
});

test('formatBytes steps up through KB, MB, and GB', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2), '1.0 MB');
  assert.equal(formatBytes(3.5 * 1024 ** 2), '3.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

test('formatRate appends a per-second suffix', () => {
  assert.equal(formatRate(1024), '1.0 KB/s');
  assert.equal(formatRate(3.1 * 1024 ** 2), '3.1 MB/s');
});

test('formatRate renders a dash for zero and non-finite rates', () => {
  assert.equal(formatRate(0), '—');
  assert.equal(formatRate(Infinity), '—');
  assert.equal(formatRate(NaN), '—');
});

test('formatDuration renders seconds and minutes', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(15_000), '15s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(600_000), '10m 0s');
});

test('formatDuration renders a dash for non-finite durations', () => {
  assert.equal(formatDuration(Infinity), '—');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(formatDuration(-1), '—');
});

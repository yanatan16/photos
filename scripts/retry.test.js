import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

test('returns the value without retrying when the operation succeeds', async () => {
  const notices = [];
  let calls = 0;

  const value = await withRetry(async () => {
    calls += 1;
    return 'ok';
  }, { baseDelayMs: 1, onRetry: (info) => notices.push(info) });

  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(notices, []);
});

test('retries until the operation succeeds', async () => {
  const notices = [];
  let calls = 0;

  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`fail ${calls}`);
    return 'ok';
  }, { baseDelayMs: 1, onRetry: (info) => notices.push(info) });

  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].attempt, 1);
  assert.equal(notices[0].attempts, 4);
  assert.equal(notices[0].error.message, 'fail 1');
});

test('doubles the backoff on each retry', async () => {
  const notices = [];

  await assert.rejects(() => withRetry(async () => {
    throw new Error('always');
  }, { baseDelayMs: 10, onRetry: (info) => notices.push(info) }));

  assert.deepEqual(notices.map(notice => notice.backoffMs), [10, 20, 40]);
});

test('rethrows the final error after exhausting attempts', async () => {
  let calls = 0;

  await assert.rejects(
    () => withRetry(async () => {
      calls += 1;
      throw new Error(`fail ${calls}`);
    }, { baseDelayMs: 1 }),
    /fail 4/,
  );

  assert.equal(calls, 4);
});

test('honours a custom attempt count', async () => {
  let calls = 0;

  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw new Error('nope');
  }, { attempts: 2, baseDelayMs: 1 }));

  assert.equal(calls, 2);
});

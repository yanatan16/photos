import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);

  await mapWithConcurrency(items, 3, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(5);
    inFlight -= 1;
  });

  assert.equal(maxInFlight, 3);
});

test('returns results in input order regardless of completion order', async () => {
  const results = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms) => {
    await sleep(ms);
    return ms * 2;
  });

  assert.deepEqual(results.map(result => result.value), [60, 20, 40, 0]);
  assert.deepEqual(results.map(result => result.item), [30, 10, 20, 0]);
});

test('isolates a failing worker and keeps the pool running', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });

  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, undefined);
  assert.equal(results[1].error.message, 'boom');
  assert.equal(results[2].value, 3);
});

test('passes the index to the worker', async () => {
  const results = await mapWithConcurrency(['a', 'b'], 2, async (item, index) => `${item}${index}`);
  assert.deepEqual(results.map(result => result.value), ['a0', 'b1']);
});

test('handles an empty list and a limit above the list length', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);

  const results = await mapWithConcurrency([1, 2], 10, async (n) => n);
  assert.deepEqual(results.map(result => result.value), [1, 2]);
});

test('parseConcurrencyFlag extracts the flag and strips it from the args', () => {
  assert.deepEqual(
    parseConcurrencyFlag(['--concurrency', '12', 'album', 'a.jpg']),
    { concurrency: 12, rest: ['album', 'a.jpg'] },
  );
  assert.deepEqual(
    parseConcurrencyFlag(['album', '--concurrency', '3', 'a.jpg']),
    { concurrency: 3, rest: ['album', 'a.jpg'] },
  );
});

test('parseConcurrencyFlag returns null when the flag is absent', () => {
  assert.deepEqual(
    parseConcurrencyFlag(['album', 'a.jpg']),
    { concurrency: null, rest: ['album', 'a.jpg'] },
  );
});

test('parseConcurrencyFlag rejects non-positive-integer values', () => {
  for (const bad of ['0', '-1', '2.5', 'abc', undefined]) {
    assert.throws(
      () => parseConcurrencyFlag(['--concurrency', bad].filter(arg => arg !== undefined)),
      /positive integer/,
    );
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPending, removePending, parsePending, pendingEntriesUnder, createPendingQueue,
} from './pendingOriginals.js';

const entry = (name) => ({ localPath: `/photos/${name}`, key: `album/${name}` });

// ── pure operations ───────────────────────────────────────────────────────────

test('addPending appends an entry', () => {
  assert.deepEqual(addPending([], entry('a.jpg')), [entry('a.jpg')]);
  assert.deepEqual(addPending([entry('a.jpg')], entry('b.jpg')), [entry('a.jpg'), entry('b.jpg')]);
});

test('addPending replaces rather than duplicates a repeated key', () => {
  const moved = { localPath: '/elsewhere/a.jpg', key: 'album/a.jpg' };
  assert.deepEqual(addPending([entry('a.jpg')], moved), [moved]);
});

test('removePending drops one entry and keeps the order of the rest', () => {
  const entries = [entry('a.jpg'), entry('b.jpg'), entry('c.jpg')];
  assert.deepEqual(removePending(entries, 'album/b.jpg'), [entry('a.jpg'), entry('c.jpg')]);
});

test('removePending is a no-op for an unknown key', () => {
  assert.deepEqual(removePending([entry('a.jpg')], 'album/zz.jpg'), [entry('a.jpg')]);
});

test('pendingEntriesUnder matches an exact single-file key', () => {
  const entries = [entry('a.jpg'), entry('b.jpg')];
  assert.deepEqual(pendingEntriesUnder(entries, 'album/a.jpg'), [entry('a.jpg')]);
});

test('pendingEntriesUnder matches entries beneath an album prefix', () => {
  const entries = [entry('a.jpg'), entry('b.jpg'), { localPath: '/photos/c.jpg', key: 'other/c.jpg' }];
  assert.deepEqual(pendingEntriesUnder(entries, 'album'), [entry('a.jpg'), entry('b.jpg')]);
});

test('pendingEntriesUnder does not match a prefix that merely shares characters', () => {
  const entries = [{ localPath: '/photos/x.jpg', key: 'album-2/x.jpg' }];
  assert.deepEqual(pendingEntriesUnder(entries, 'album'), []);
});

test('pendingEntriesUnder returns an empty array when nothing matches', () => {
  assert.deepEqual(pendingEntriesUnder([entry('a.jpg')], 'other'), []);
});

test('parsePending returns an array, or empty for anything unusable', () => {
  assert.deepEqual(parsePending('[{"localPath":"/photos/a.jpg","key":"album/a.jpg"}]'), [entry('a.jpg')]);
  assert.deepEqual(parsePending(''), []);
  assert.deepEqual(parsePending('not json'), []);
  assert.deepEqual(parsePending('{"not":"an array"}'), []);
});

// ── queue ─────────────────────────────────────────────────────────────────────

const fakeFile = (initial = '[]') => {
  const file = { text: initial };
  return {
    file,
    read: () => file.text,
    write: (text) => { file.text = text; },
  };
};

test('createPendingQueue persists an added entry', async () => {
  const { file, read, write } = fakeFile();
  const queue = createPendingQueue({ read, write });

  await queue.add(entry('a.jpg'));

  assert.deepEqual(JSON.parse(file.text), [entry('a.jpg')]);
  assert.deepEqual(queue.load(), [entry('a.jpg')]);
});

test('createPendingQueue serializes concurrent adds without dropping any', async () => {
  const { file, read, write } = fakeFile();
  const queue = createPendingQueue({ read, write });

  await Promise.all([
    queue.add(entry('a.jpg')),
    queue.add(entry('b.jpg')),
    queue.add(entry('c.jpg')),
  ]);

  const keys = JSON.parse(file.text).map(pending => pending.key).sort();
  assert.deepEqual(keys, ['album/a.jpg', 'album/b.jpg', 'album/c.jpg']);
});

test('createPendingQueue removes an entry', async () => {
  const { file, read, write } = fakeFile(JSON.stringify([entry('a.jpg'), entry('b.jpg')]));
  const queue = createPendingQueue({ read, write });

  await queue.remove('album/a.jpg');

  assert.deepEqual(JSON.parse(file.text), [entry('b.jpg')]);
});

test('createPendingQueue treats a malformed manifest as empty', () => {
  const { read, write } = fakeFile('}{ broken');
  assert.deepEqual(createPendingQueue({ read, write }).load(), []);
});

test('createPendingQueue recovers after a write failure instead of poisoning later calls', async () => {
  const { file, read, write } = fakeFile();
  let failNext = true;
  const flakyWrite = (text) => {
    if (failNext) {
      failNext = false;
      throw new Error('ENOSPC');
    }
    write(text);
  };
  const queue = createPendingQueue({ read, write: flakyWrite });

  await assert.rejects(() => queue.add(entry('a.jpg')), /ENOSPC/);
  await queue.add(entry('b.jpg'));

  assert.deepEqual(JSON.parse(file.text), [entry('b.jpg')]);
});

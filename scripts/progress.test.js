import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBar, renderDisplay, createProgressDisplay } from './progress.js';

const task = (overrides = {}) => ({
  name: 'photo.jpg',
  total: null,
  loaded: 0,
  state: 'queued',
  note: null,
  ...overrides,
});

const baseState = (overrides = {}) => ({
  label: 'Uploading 2 photo(s) to album/',
  total: 2,
  completed: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: 1000,
  now: 1000,
  tasks: [],
  ...overrides,
});

// ── renderBar ─────────────────────────────────────────────────────────────────

test('renderBar fills proportionally and keeps a constant width', () => {
  assert.equal(renderBar(0, 4), '[░░░░]');
  assert.equal(renderBar(0.5, 4), '[██░░]');
  assert.equal(renderBar(1, 4), '[████]');
});

test('renderBar clamps out-of-range and non-finite fractions', () => {
  assert.equal(renderBar(-1, 4), '[░░░░]');
  assert.equal(renderBar(2, 4), '[████]');
  assert.equal(renderBar(NaN, 4), '[░░░░]');
  assert.equal(renderBar(Infinity, 4), '[████]');
});

// ── renderDisplay ─────────────────────────────────────────────────────────────

test('renderDisplay shows a byte bar for an active sized task', () => {
  const lines = renderDisplay(baseState({
    tasks: [task({ name: 'a.jpg', state: 'active', total: 4 * 1024 ** 2, loaded: 1024 ** 2 })],
  }));

  const line = lines.find(candidate => candidate.includes('a.jpg'));
  assert.match(line, /25%/);
  assert.match(line, /1\.0 MB \/ 4\.0 MB/);
});

test('renderDisplay shows queued tasks in count mode', () => {
  const lines = renderDisplay(baseState({ tasks: [task({ name: 'b.jpg' })] }));

  const line = lines.find(candidate => candidate.includes('b.jpg'));
  assert.match(line, /queued/);
  assert.doesNotMatch(line, /%/);
});

test('renderDisplay appends a stage note to a sized task', () => {
  const lines = renderDisplay(baseState({
    tasks: [task({ name: 'c.jpg', state: 'active', total: 100, loaded: 100, note: 'resizing' })],
  }));

  assert.match(lines.find(candidate => candidate.includes('c.jpg')), /resizing/);
});

test('renderDisplay hides finished tasks but counts them in the total line', () => {
  const lines = renderDisplay(baseState({
    completed: 1,
    tasks: [task({ name: 'done.jpg', state: 'done' }), task({ name: 'next.jpg' })],
  }));

  assert.equal(lines.some(candidate => candidate.includes('done.jpg')), false);
  assert.match(lines.at(-1), /1\/2/);
});

test('renderDisplay derives rate and eta from the injected clock', () => {
  const lines = renderDisplay(baseState({
    bytesDone: 2 * 1024 ** 2,
    bytesTotal: 6 * 1024 ** 2,
    startedAt: 1000,
    now: 3000,
  }));

  // 2 MB in 2 s = 1 MB/s; 4 MB remaining = 4 s
  assert.match(lines.at(-1), /1\.0 MB\/s/);
  assert.match(lines.at(-1), /eta 4s/);
});

test('renderDisplay avoids NaN and Infinity when no time has elapsed', () => {
  const lines = renderDisplay(baseState({ bytesDone: 0, bytesTotal: 100, startedAt: 1000, now: 1000 }));

  assert.doesNotMatch(lines.at(-1), /NaN|Infinity/);
});

test('renderDisplay reports failures in the total line', () => {
  const lines = renderDisplay(baseState({ completed: 1, failed: 1, tasks: [] }));

  assert.match(lines.at(-1), /1 failed/);
});

test('renderDisplay caps the number of task rows at maxRows', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task({ name: `photo-${index}.jpg` }));
  const lines = renderDisplay(baseState({ total: 10, tasks, maxRows: 3 }));

  const taskLines = lines.filter(candidate => candidate.includes('.jpg'));
  assert.equal(taskLines.length, 3);
});

// ── createProgressDisplay ─────────────────────────────────────────────────────

const fakeStream = ({ isTTY }) => {
  const writes = [];
  return { isTTY, columns: 100, write: (chunk) => writes.push(chunk), writes };
};

test('createProgressDisplay writes plain lines on a non-TTY stream', () => {
  const stream = fakeStream({ isTTY: false });
  const display = createProgressDisplay({
    label: 'Uploading 2 photo(s)',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: 10 }, { id: 'b', name: 'b.jpg', totalBytes: 10 }],
    stream,
    clock: () => 0,
  });

  display.startTask('a');
  display.updateTask('a', 5);
  display.finishTask('a');
  display.finishTask('b', { error: new Error('nope') });
  display.stop();

  const output = stream.writes.join('');
  assert.match(output, /Uploading 2 photo\(s\)/);
  assert.match(output, /✓ a\.jpg/);
  assert.match(output, /✗ b\.jpg — nope/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('createProgressDisplay emits cursor escapes on a TTY and restores the cursor', () => {
  const stream = fakeStream({ isTTY: true });
  const display = createProgressDisplay({
    label: 'Uploading',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: 10 }],
    stream,
    clock: () => 0,
  });

  display.stop();

  const output = stream.writes.join('');
  assert.match(output, /\x1b\[\?25l/); // cursor hidden
  assert.match(output, /\x1b\[\?25h/); // cursor restored
});

test('createProgressDisplay truncates lines to the stream width', () => {
  const stream = { isTTY: true, columns: 20, writes: [], write(chunk) { this.writes.push(chunk); } };
  const display = createProgressDisplay({
    label: 'A label far wider than twenty columns of terminal',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: 10 }],
    stream,
    clock: () => 0,
  });

  display.stop();

  const rendered = stream.writes.join('').split('\n').filter(line => !line.startsWith('\x1b[?25'));
  for (const line of rendered) {
    assert.ok(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length <= 20);
  }
});

test('createProgressDisplay tracks completed and failed counts', () => {
  const stream = fakeStream({ isTTY: false });
  const display = createProgressDisplay({
    label: 'Uploading',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: 10 }, { id: 'b', name: 'b.jpg', totalBytes: 10 }],
    stream,
    clock: () => 0,
  });

  display.finishTask('a');
  display.finishTask('b', { error: new Error('boom') });
  display.stop();

  assert.deepEqual(display.counts(), { completed: 1, failed: 1 });
});

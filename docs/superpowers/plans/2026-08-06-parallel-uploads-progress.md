# Parallel Uploads with Progress Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/upload-photos.js` and `scripts/process.js` run their work concurrently with live per-file progress bars, on four shared modules neither script owns privately.

**Architecture:** Four new leaf modules (`format.js`, `concurrency.js`, `retry.js`, `progress.js`) are built and tested bottom-up, then the two scripts are rewritten onto them. `progress.js` splits into pure renderers (unit-tested) and a thin effectful terminal shell. The worker pool settles rather than rejects, so error policy stays in the callers.

**Tech Stack:** Node 20+ ESM, `node --test`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (new), `sharp`, `exifr`.

## Global Constraints

- ESM only — every file uses `import`/`export`, never `require`. `package.json` has `"type": "module"`.
- Tests are `node --test`, colocated as `scripts/<name>.test.js`, using `node:test` and `node:assert/strict`. No test framework, no mocking library.
- Tests must be pure — no network, no R2, no filesystem writes. Inject `clock` and `stream` rather than reading the real clock or writing the real terminal.
- Style matches the existing repo: arrow-function consts, named exports, `// ── section ──` banner comments, no semicolon-free style, 2-space indent.
- No new runtime dependencies beyond `@aws-sdk/lib-storage`, which goes in `devDependencies` alongside `@aws-sdk/client-s3`.
- Concurrency defaults: **6** uploads, **8** EXIF fetches, **4** image processes. `--concurrency N` overrides all of them.
- Retry policy is unchanged from today: **4** attempts, **500ms** base delay, doubling (`500 * 2 ** (attempt - 1)`).
- Never call `console.*` while progress bars are live — retry and stage notices route through `noteTask`.

---

### Task 1: `format.js` — byte, rate, and duration formatting

`r2.js` already has a `formatSize` at line 21. It moves here and `r2.js` imports it, so the repo has exactly one copy.

**Files:**
- Create: `scripts/format.js`
- Create: `scripts/format.test.js`
- Modify: `scripts/r2.js` (delete lines 21-26, add import, rename call site at line 40)

**Interfaces:**
- Consumes: nothing.
- Produces: `formatBytes(bytes: number) => string`, `formatRate(bytesPerSecond: number) => string`, `formatDuration(ms: number) => string`.

- [ ] **Step 1: Write the failing test**

Create `scripts/format.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/format.test.js`
Expected: FAIL — `Cannot find module .../scripts/format.js`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/format.js`:

```js
export const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

export const formatRate = (bytesPerSecond) =>
  Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
    ? `${formatBytes(Math.round(bytesPerSecond))}/s`
    : '—';

export const formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/format.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Point `r2.js` at the shared helper**

In `scripts/r2.js`, delete the local `formatSize` (lines 21-26 in the current file, the whole `const formatSize = (bytes) => { ... };` block), and add the import next to the existing `r2client.js` import at the top:

```js
import { createS3Client, getBucketName } from './r2client.js';
import { formatBytes } from './format.js';
```

Then in `ls`, change the one call site:

```js
    const size = formatBytes(obj.Size).padStart(9);
```

- [ ] **Step 6: Verify nothing else referenced the old name**

Run: `grep -rn "formatSize" scripts/`
Expected: no output.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — 34 tests (28 pre-existing + 6 new), 0 fail

- [ ] **Step 8: Commit**

```bash
git add scripts/format.js scripts/format.test.js scripts/r2.js
git commit -m "Add shared format helpers and drop r2.js formatSize copy"
```

---

### Task 2: `concurrency.js` — bounded worker pool

**Files:**
- Create: `scripts/concurrency.js`
- Create: `scripts/concurrency.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `mapWithConcurrency(items: T[], limit: number, worker: (item: T, index: number) => Promise<V>) => Promise<Array<{ item: T, value?: V, error?: Error }>>` — results in input order, never rejects.
  - `parseConcurrencyFlag(args: string[]) => { concurrency: number | null, rest: string[] }` — throws on a non-positive-integer value.

- [ ] **Step 1: Write the failing test**

Create `scripts/concurrency.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/concurrency.test.js`
Expected: FAIL — `Cannot find module .../scripts/concurrency.js`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/concurrency.js`:

```js
export const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      try {
        results[index] = { item, value: await worker(item, index) };
      } catch (error) {
        results[index] = { item, error };
      }
    }
  };

  const workerCount = Math.max(0, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results;
};

export const parseConcurrencyFlag = (args) => {
  const index = args.indexOf('--concurrency');
  if (index === -1) return { concurrency: null, rest: args };

  const raw = args[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error('--concurrency requires a positive integer');
  }

  return {
    concurrency: value,
    rest: [...args.slice(0, index), ...args.slice(index + 2)],
  };
};
```

Note: `nextIndex` is read and incremented synchronously before any `await`, so the workers cannot claim the same index.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/concurrency.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/concurrency.js scripts/concurrency.test.js
git commit -m "Add bounded worker pool with settle-don't-throw semantics"
```

---

### Task 3: `retry.js` — retry with injected notifications

Lifts `withRetry` out of `upload-photos.js` (lines 20-36). Same policy; the two `console.warn` calls become an injected callback so retries can render into a progress bar instead of scrambling it.

**Files:**
- Create: `scripts/retry.js`
- Create: `scripts/retry.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `withRetry(operation: () => Promise<T>, options?: { attempts?: number, baseDelayMs?: number, onRetry?: (info) => void }) => Promise<T>` where `info` is `{ attempt: number, attempts: number, error: Error, backoffMs: number }`. Defaults: `attempts: 4`, `baseDelayMs: 500`.

- [ ] **Step 1: Write the failing test**

Create `scripts/retry.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/retry.test.js`
Expected: FAIL — `Cannot find module .../scripts/retry.js`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/retry.js`:

```js
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const withRetry = async (operation, {
  attempts = 4,
  baseDelayMs = 500,
  onRetry = () => {},
} = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) throw error;
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry({ attempt, attempts, error, backoffMs });
      await delay(backoffMs);
    }
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/retry.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/retry.js scripts/retry.test.js
git commit -m "Extract withRetry into a shared module with injected notices"
```

---

### Task 4: `progress.js` — pure renderers plus terminal shell

**Files:**
- Create: `scripts/progress.js`
- Create: `scripts/progress.test.js`

**Interfaces:**
- Consumes: `formatBytes`, `formatRate`, `formatDuration` from `./format.js` (Task 1).
- Produces:
  - `renderBar(fraction: number, width: number) => string`
  - `renderDisplay(state) => string[]` where `state` is `{ label, total, completed, failed, bytesDone, bytesTotal, startedAt, now, tasks, maxRows? }` and each task is `{ name, total: number|null, loaded: number, state: 'queued'|'active'|'done'|'failed', note: string|null }`
  - `createProgressDisplay({ label, items, stream?, clock?, redrawMs?, maxRows? }) => { startTask, updateTask, noteTask, finishTask, stop }` where `items` is `[{ id, name, totalBytes: number|null }]`

- [ ] **Step 1: Write the failing test**

Create `scripts/progress.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/progress.test.js`
Expected: FAIL — `Cannot find module .../scripts/progress.js`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/progress.js`:

```js
import { formatBytes, formatRate, formatDuration } from './format.js';

// ── constants ─────────────────────────────────────────────────────────────────

const TASK_BAR_WIDTH = 14;
const TOTAL_BAR_WIDTH = 21;
const REDRAW_MS = 100;
const MAX_ROWS = 8;

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_BELOW = '\x1b[0J';

// ── pure renderers ────────────────────────────────────────────────────────────

export const renderBar = (fraction, width) => {
  const clamped = Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
};

const renderTaskDetail = (task) => {
  if (task.state === 'active' && task.total > 0) {
    const fraction = task.loaded / task.total;
    const percent = String(Math.round(Math.min(1, fraction) * 100)).padStart(3);
    const bytes = `${formatBytes(task.loaded)} / ${formatBytes(task.total)}`;
    const detail = task.note ? `${bytes}  ${task.note}` : bytes;
    return `${renderBar(fraction, TASK_BAR_WIDTH)}  ${percent}%   ${detail}`;
  }

  const detail = task.note ?? (task.state === 'queued' ? 'queued' : 'working');
  return `${renderBar(0, TASK_BAR_WIDTH)}   —    ${detail}`;
};

export const renderDisplay = (state) => {
  const {
    label, total, completed, failed,
    bytesDone, bytesTotal, startedAt, now,
    tasks, maxRows = MAX_ROWS,
  } = state;

  const active = tasks.filter(task => task.state === 'active');
  const queued = tasks.filter(task => task.state === 'queued');
  const visible = [...active, ...queued].slice(0, maxRows);
  const nameWidth = visible.reduce((width, task) => Math.max(width, task.name.length), 0);

  const elapsedMs = Math.max(0, now - startedAt);
  const rate = elapsedMs > 0 ? (bytesDone / elapsedMs) * 1000 : 0;
  const fraction = bytesTotal > 0
    ? bytesDone / bytesTotal
    : (total > 0 ? completed / total : 0);
  const etaMs = rate > 0 && bytesTotal > 0
    ? ((bytesTotal - bytesDone) / rate) * 1000
    : Infinity;

  const summary = [`${completed}/${total}`, formatRate(rate), `eta ${formatDuration(etaMs)}`];
  if (failed > 0) summary.push(`${failed} failed`);

  return [
    label,
    '',
    ...visible.map(task => `  ${task.name.padEnd(nameWidth)}  ${renderTaskDetail(task)}`),
    '',
    `  total  ${renderBar(fraction, TOTAL_BAR_WIDTH)}  ${summary.join('  •  ')}`,
  ];
};

// ── terminal shell ────────────────────────────────────────────────────────────

const visibleLength = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

export const createProgressDisplay = ({
  label,
  items,
  stream = process.stdout,
  clock = Date.now,
  redrawMs = REDRAW_MS,
  maxRows = MAX_ROWS,
}) => {
  const tasks = new Map(items.map(item => [item.id, {
    name: item.name,
    total: item.totalBytes ?? null,
    loaded: 0,
    state: 'queued',
    note: null,
  }]));

  const bytesTotal = items.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0);
  const startedAt = clock();
  const isTTY = Boolean(stream.isTTY);

  let completed = 0;
  let failed = 0;
  let lastLineCount = 0;
  let timer = null;

  const snapshot = () => ({
    label,
    total: items.length,
    completed,
    failed,
    bytesDone: [...tasks.values()].reduce((sum, task) => sum + task.loaded, 0),
    bytesTotal,
    startedAt,
    now: clock(),
    maxRows,
    tasks: [...tasks.values()],
  });

  const truncate = (line) => {
    const width = (stream.columns ?? 80);
    return visibleLength(line) > width ? `${line.slice(0, width - 1)}…` : line;
  };

  const paint = () => {
    const lines = renderDisplay(snapshot()).map(truncate);
    const moveUp = lastLineCount > 0 ? `\x1b[${lastLineCount}A` : '';
    stream.write(`${moveUp}${CLEAR_BELOW}${lines.join('\n')}\n`);
    lastLineCount = lines.length;
  };

  const patch = (id, changes) => {
    const task = tasks.get(id);
    if (task) Object.assign(task, changes);
  };

  if (isTTY) {
    stream.write(HIDE_CURSOR);
    paint();
    timer = setInterval(paint, redrawMs);
    timer.unref?.();
  } else {
    stream.write(`${label}\n`);
  }

  return {
    startTask: (id) => patch(id, { state: 'active', note: null }),
    updateTask: (id, loaded) => patch(id, { loaded }),
    noteTask: (id, note) => patch(id, { note }),

    finishTask: (id, { error } = {}) => {
      const task = tasks.get(id);
      if (!task) return;

      if (error) {
        failed += 1;
        Object.assign(task, { state: 'failed', note: error.message });
      } else {
        completed += 1;
        Object.assign(task, { state: 'done', loaded: task.total ?? task.loaded, note: null });
      }

      if (!isTTY) {
        stream.write(error ? `  ✗ ${task.name} — ${error.message}\n` : `  ✓ ${task.name}\n`);
      }
    },

    counts: () => ({ completed, failed }),

    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (isTTY) {
        paint();
        stream.write(SHOW_CURSOR);
      }
    },
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/progress.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — 61 tests, 0 fail

- [ ] **Step 6: Commit**

```bash
git add scripts/progress.js scripts/progress.test.js
git commit -m "Add multi-bar progress display with pure renderers"
```

---

### Task 5: Rewrite `upload-photos.js` onto the shared modules

**Files:**
- Modify: `scripts/upload-photos.js` (full rewrite)
- Create: `scripts/upload-photos.test.js`
- Modify: `package.json` (add `@aws-sdk/lib-storage` to `devDependencies`)

**Interfaces:**
- Consumes: `createS3Client`/`getBucketName` from `./r2client.js`; `mapWithConcurrency`/`parseConcurrencyFlag` from `./concurrency.js` (Task 2); `createProgressDisplay` from `./progress.js` (Task 4); `withRetry` from `./retry.js` (Task 3).
- Produces: `parseArgs(args: string[]) => { folder, files, concurrency }` — exported for tests.

- [ ] **Step 1: Install the upload dependency**

Run: `npm install --save-dev @aws-sdk/lib-storage`
Expected: `package.json` gains `"@aws-sdk/lib-storage"` under `devDependencies`, `package-lock.json` updates.

- [ ] **Step 2: Write the failing test**

Create `scripts/upload-photos.test.js`. Only `parseArgs` is unit-tested — the rest of the script is R2-effecting and is verified manually in Step 7.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './upload-photos.js';

test('parseArgs splits the folder from the files', () => {
  assert.deepEqual(parseArgs(['iceland-2026', 'a.jpg', 'b.jpg']), {
    folder: 'iceland-2026',
    files: ['a.jpg', 'b.jpg'],
    concurrency: 6,
  });
});

test('parseArgs honours --concurrency in any position', () => {
  assert.equal(parseArgs(['--concurrency', '3', 'album', 'a.jpg']).concurrency, 3);
  assert.equal(parseArgs(['album', '--concurrency', '3', 'a.jpg']).concurrency, 3);
  assert.deepEqual(parseArgs(['album', '--concurrency', '3', 'a.jpg']).files, ['a.jpg']);
});

test('parseArgs rejects a missing folder or file list', () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['album']), /Usage:/);
});

test('parseArgs rejects an invalid concurrency', () => {
  assert.throws(() => parseArgs(['--concurrency', '0', 'album', 'a.jpg']), /positive integer/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test scripts/upload-photos.test.js`
Expected: FAIL — `parseArgs` is not exported (`The requested module './upload-photos.js' does not provide an export named 'parseArgs'`)

- [ ] **Step 4: Rewrite the script**

Replace the entire contents of `scripts/upload-photos.js`:

```js
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, existsSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';

// ── constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic']);

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
};

const DEFAULT_CONCURRENCY = 6;

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] <folder> <file1> [file2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

export const parseArgs = (args) => {
  const { concurrency, rest } = parseConcurrencyFlag(args);
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...files] = rest;
  return { folder, files, concurrency: concurrency ?? DEFAULT_CONCURRENCY };
};

const validateFiles = (files) => {
  const errors = files.flatMap((file) => {
    if (!existsSync(file)) return [`File not found: ${file}`];
    const ext = extname(file).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext) ? [] : [`Unsupported file type: ${file} (${ext})`];
  });

  if (errors.length > 0) throw new Error(errors.join('\n'));
};

// ── upload ────────────────────────────────────────────────────────────────────

// The Upload — and its read stream — are built inside the retried closure on
// purpose: a consumed stream cannot be replayed, so a retry that reused it
// would upload a zero-byte object.
const uploadFile = (client, bucketName, item, hooks) =>
  withRetry(() => {
    hooks.onAttemptStart();

    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: item.key,
        Body: createReadStream(item.filePath),
        ContentType: MIME_TYPES[extname(item.filePath).toLowerCase()] ?? 'application/octet-stream',
      },
    });

    upload.on('httpUploadProgress', ({ loaded }) => hooks.onProgress(loaded ?? 0));
    return upload.done();
  }, { onRetry: hooks.onRetry });

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const { folder, files, concurrency } = parseArgs(process.argv.slice(2));
  validateFiles(files);

  const client = createS3Client();
  const bucketName = getBucketName();

  const items = files.map(filePath => ({
    id: filePath,
    filePath,
    name: basename(filePath),
    key: `${folder}/${basename(filePath)}`,
    totalBytes: statSync(filePath).size,
  }));

  const display = createProgressDisplay({
    label: `Uploading ${items.length} photo(s) to ${folder}/`,
    items,
  });

  let results;
  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      try {
        await uploadFile(client, bucketName, item, {
          onAttemptStart: () => display.updateTask(item.id, 0),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
          onRetry: ({ attempt, attempts }) => {
            display.updateTask(item.id, 0);
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);
          },
        });
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
      return item.key;
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`\n${results.length - failures.length}/${results.length} uploaded to ${folder}/`);

  if (failures.length > 0) {
    console.error('\nFailed:');
    for (const failure of failures) {
      console.error(`  ${failure.item.key}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }
};

run().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
```

Note: importing this module for tests runs `run()`, which throws the usage error and would exit. Guard it — see the next step.

- [ ] **Step 5: Guard the entry point so the module is importable**

The test imports `parseArgs`, which would otherwise trigger `run()`. Replace the final `run().catch(...)` block with:

```js
const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  run().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test scripts/upload-photos.test.js`
Expected: PASS — 4 tests

Run: `npm test`
Expected: PASS — 65 tests, 0 fail

- [ ] **Step 7: Verify against the real bucket**

Pick two or three real photos and upload them to a scratch folder:

```bash
node scripts/upload-photos.js --concurrency 3 zz-scratch ~/Photograph/**/*.jpg
```

Confirm by eye: multiple bars advance at once, the total line shows a plausible rate and ETA, and the cursor returns after the run. Then check the objects landed and clean up:

```bash
node scripts/r2.js ls zz-scratch
node scripts/r2.js rm zz-scratch
```

Also confirm the non-TTY path is clean:

```bash
node scripts/upload-photos.js zz-scratch2 <one-file> | cat
node scripts/r2.js rm zz-scratch2
```

Expected: plain `✓ name` lines, no escape sequences in the piped output.

- [ ] **Step 8: Commit**

```bash
git add scripts/upload-photos.js scripts/upload-photos.test.js package.json package-lock.json
git commit -m "Upload photos in parallel with per-file progress bars"
```

---

### Task 6: Rewrite the `process.js` loops

**Files:**
- Modify: `scripts/process.js` (`processExif`, `processImages`, `run`)

**Interfaces:**
- Consumes: `mapWithConcurrency`/`parseConcurrencyFlag` (Task 2), `createProgressDisplay` (Task 4), `withRetry` (Task 3).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the imports and concurrency constants**

At the top of `scripts/process.js`, after the existing `r2client.js` import:

```js
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';
```

And in the constants block, after `EXIF_FETCH_BYTES`:

```js
const EXIF_CONCURRENCY = 8;
const IMAGE_CONCURRENCY = 4;
```

- [ ] **Step 2: Rewrite `processExif`**

Replace the whole `processExif` function with:

```js
const processExif = async (client, bucketName, photoKeys, publicUrl, force, concurrency) => {
  console.log('\n── EXIF extraction ──────────────────────────────────────────');
  const cache = force ? {} : await loadJson(client, bucketName, EXIF_CACHE_KEY);
  const toProcess = photoKeys.filter(key => cache[key] === undefined);

  if (force) console.log(`--force: reprocessing all ${photoKeys.length} photos`);
  else console.log(`Cache: ${Object.keys(cache).length} entries, ${toProcess.length} to process`);

  if (toProcess.length === 0) {
    console.log('All photos cached, nothing to do.');
    return;
  }

  // saveJson serializes the whole cache object, so two overlapping saves can
  // land out of order and drop entries. Chain them so only one is ever in flight.
  let pendingSave = Promise.resolve();
  const queueSave = () => {
    pendingSave = pendingSave.then(() =>
      withRetry(() => saveJson(client, bucketName, EXIF_CACHE_KEY, cache)));
  };

  const items = toProcess.map(key => ({ id: key, name: key, totalBytes: null }));
  const display = createProgressDisplay({
    label: `Extracting EXIF from ${items.length} photo(s)`,
    items,
  });

  let done = 0;
  let results;

  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      try {
        const buffer = await withRetry(() => fetchExifChunk(publicUrl, item.id), {
          onRetry: ({ attempt, attempts }) =>
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`),
        });
        cache[item.id] = await parseExif(buffer);
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
      done += 1;
      if (done % 10 === 0) queueSave();
      return cache[item.id];
    });
  } finally {
    display.stop();
    await pendingSave;
    await withRetry(() => saveJson(client, bucketName, EXIF_CACHE_KEY, cache));
  }

  const failures = results.filter(result => result.error);
  console.log(`Saved cache (${Object.keys(cache).length} entries). Processed ${done} new photos.`);

  if (failures.length > 0) {
    console.error(`${failures.length} photo(s) failed EXIF extraction:`);
    for (const failure of failures) console.error(`  ${failure.item.id}: ${failure.error.message}`);
  }
};
```

- [ ] **Step 3: Rewrite `processImages`**

Replace the whole `processImages` function with:

```js
const processImages = async (client, bucketName, photoKeys, objects, concurrency) => {
  console.log('\n── Image processing ─────────────────────────────────────────');

  const existingThumbnails = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${THUMBNAIL_DIR}/`)));
  const existingWebPhotos = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${WEB_DIR}/`)));
  const sizeByKey = new Map(objects.map(o => [o.Key, o.Size]));

  const photosNeedingWork = photoKeys.filter(key =>
    !existingThumbnails.has(thumbnailKey(key)) || !existingWebPhotos.has(webKey(key))
  );

  if (photosNeedingWork.length === 0) {
    console.log('All thumbnails and web-sized photos up to date.');
    return;
  }

  const items = photosNeedingWork.map(key => ({
    id: key,
    name: key,
    totalBytes: sizeByKey.get(key) ?? null,
  }));

  const display = createProgressDisplay({
    label: `Processing ${items.length} photo(s)`,
    items,
  });

  let results;

  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      const onRetry = ({ attempt, attempts }) =>
        display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);

      try {
        const original = await withRetry(
          () => downloadObject(client, bucketName, item.id),
          { onRetry },
        );
        display.updateTask(item.id, item.totalBytes ?? 0);

        const needsThumbnail = !existingThumbnails.has(thumbnailKey(item.id));
        const needsWeb = !existingWebPhotos.has(webKey(item.id));

        display.noteTask(item.id, 'resizing');
        const [thumbnail, web] = await Promise.all([
          needsThumbnail ? makeThumbnail(original) : null,
          needsWeb ? makeWebSized(original) : null,
        ]);

        display.noteTask(item.id, 'uploading');
        await Promise.all([
          thumbnail && withRetry(
            () => uploadObject(client, bucketName, thumbnailKey(item.id), thumbnail),
            { onRetry },
          ),
          web && withRetry(
            () => uploadObject(client, bucketName, webKey(item.id), web),
            { onRetry },
          ),
        ].filter(Boolean));
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`${results.length - failures.length}/${results.length} photo(s) processed.`);

  if (failures.length > 0) {
    console.error(`${failures.length} photo(s) failed:`);
    for (const failure of failures) console.error(`  ${failure.item.id}: ${failure.error.message}`);
    process.exitCode = 1;
  }
};
```

- [ ] **Step 4: Thread the concurrency flag through `run`**

Replace the `run` function with:

```js
const run = async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const { concurrency } = parseConcurrencyFlag(args.filter(arg => arg !== '--force'));

  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) throw new Error('Missing R2_PUBLIC_URL in environment variables');

  const client = createS3Client();
  const bucketName = getBucketName();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);
  const photoKeys = objects.map(o => o.Key).filter(isPhoto);
  console.log(`Found ${photoKeys.length} photos`);

  await processExif(client, bucketName, photoKeys, publicUrl, force, concurrency ?? EXIF_CONCURRENCY);
  await processImages(client, bucketName, photoKeys, objects, concurrency ?? IMAGE_CONCURRENCY);

  console.log('\nAll done!');
};
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — 65 tests, 0 fail (no new tests here; this task's verification is the live run in Step 6)

- [ ] **Step 6: Verify against the real bucket**

The bucket is already fully processed, so first confirm the no-op path still short-circuits:

```bash
node scripts/process.js
```

Expected: `All photos cached, nothing to do.` and `All thumbnails and web-sized photos up to date.` — no bars, no errors.

Then give it real work by uploading a scratch album and processing it:

```bash
node scripts/upload-photos.js zz-scratch <three real photos>
node scripts/process.js
```

Confirm by eye: the EXIF phase shows count-mode rows, the image phase shows byte bars that flip to `resizing` then `uploading`, and both phases end with a summary. Verify the derived objects exist, then clean up:

```bash
node scripts/r2.js ls zz-scratch
node scripts/r2.js rm zz-scratch
```

Note: `zz-scratch` entries stay in `exif-cache.json` after the album is removed. They are harmless (keys not in the bucket are simply never read), but if you want them gone, `node scripts/process.js --force` rebuilds the cache from scratch.

- [ ] **Step 7: Commit**

```bash
git add scripts/process.js
git commit -m "Process EXIF and image derivatives in parallel with progress bars"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `concurrency.js` — settle-don't-throw pool | 2 |
| `progress.js` — pure renderers | 4 |
| `progress.js` — timer repaint, cursor hide/restore, truncation | 4 |
| `progress.js` — non-TTY degradation | 4 |
| `progress.js` — `noteTask` for retries | 4 |
| `retry.js` — injected `onRetry`, dropped `label` | 3 |
| `format.js` — `formatBytes` moved out of `r2.js` | 1 |
| upload — drop duplicated `createS3Client` | 5 |
| upload — `lib-storage` `Upload` over a read stream | 5 |
| upload — stream rebuilt inside the retry closure | 5 |
| upload — concurrency 6, `--concurrency N` | 5 |
| process — EXIF concurrency 8, count-mode bars | 6 |
| process — chained cache saves | 6 |
| process — image concurrency 4, byte-accurate download | 6 |
| process — `withRetry` around R2 calls | 6 |
| Error handling — settle, exit 1, `finally` stop | 5, 6 |
| Testing — four test files | 1, 2, 3, 4 |

No gaps.

**Placeholder scan:** No TBD/TODO, no "add appropriate error handling", no "similar to Task N". Every code step carries real code.

**Type consistency:** `createProgressDisplay` takes `items: [{ id, name, totalBytes }]` and exposes `startTask`/`updateTask`/`noteTask`/`finishTask`/`counts`/`stop` — used with those exact names in Tasks 5 and 6. `mapWithConcurrency` returns `{ item, value?, error? }`, and both callers read `result.error`, `result.item`, and `results.length` accordingly. `withRetry(operation, { onRetry })` matches every call site. `parseConcurrencyFlag` returns `{ concurrency, rest }` in Tasks 5 and 6.

One deviation from the spec, resolved in favor of the plan: the spec sketched `createProgressDisplay({ label, total })`, but the display needs the full item list up front to show queued rows and a correct `bytesTotal`. Both call sites already know their full work list, so the constructor takes `items` and derives `total` from it.

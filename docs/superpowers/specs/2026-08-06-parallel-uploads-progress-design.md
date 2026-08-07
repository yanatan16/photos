# Parallel Uploads with Progress Bars

**Date:** 2026-08-06
**Status:** Approved design

## Goal

`scripts/upload-photos.js` and `scripts/process.js` both walk their work one item
at a time, awaiting a full network round-trip before starting the next. On an
album of a few dozen RAW-derived JPEGs this is the slowest part of publishing a
shoot, and the only feedback is a line of text after each file finishes.

Make both scripts:

1. **Run concurrently**, with a bounded worker pool.
2. **Show live progress** — a per-file bar for each in-flight item plus an
   aggregate line with throughput and ETA.

The concurrency, progress, retry, and formatting logic lives in four shared
modules so neither script owns a private copy.

## Non-Goals

- No change to CLI surface beyond one new `--concurrency` flag. `upload-photos`
  still takes `<folder> <file...>`; `process` still takes `--force`.
- No resumable or content-addressed uploads. Re-uploading an existing key still
  overwrites it, exactly as today.
- No progress for `fetch-photos.js`, `copy-images.js`, or `r2.js`. `r2.js` is
  touched only to drop its duplicated `formatSize`.

## Architecture

```
upload-photos.js ──┐
                   ├─→ concurrency.js   mapWithConcurrency(items, limit, worker)
process.js      ──┤   progress.js      createProgressDisplay(...) + pure renderers
                   ├─→ retry.js         withRetry(operation, { onRetry })
r2.js           ──┴─→ format.js        formatBytes / formatRate / formatDuration
```

### `scripts/concurrency.js` (new)

One exported function, no side effects:

```js
export const mapWithConcurrency = async (items, limit, worker) =>
  /* Array<{ item, value }|{ item, error }> in input order */;
```

At most `limit` workers run at once; each pulls the next index off a shared
cursor. **It never rejects** — a throwing `worker` yields `{ item, error }` for
that slot and the pool keeps going. Both callers want "finish the batch, then
report what failed," so settling beats fail-fast; making that the contract keeps
the error policy in the callers rather than buried in the pool.

### `scripts/progress.js` (new)

Split so the interesting logic is pure and the terminal writing is a thin shell.

**Pure** (directly unit-testable):

```js
export const renderBar = (fraction, width) => '[████░░░░]';
export const renderDisplay = (state) => [/* lines */];
```

`renderDisplay` takes the whole display state, including `startedAt` and `now` as
injected numbers, so rate and ETA are computed without reading the clock. State:

```js
{
  label, total, completed, failed,
  bytesDone, bytesTotal,
  startedAt, now,
  tasks: [{ name, loaded, total, state: 'active'|'queued'|'done'|'failed', note }],
}
```

A task with `total === null` renders in count mode (`—  queued`, or the `note`
text) instead of a byte percentage — that is how the EXIF phase and retry
notices display.

**Effectful shell:**

```js
export const createProgressDisplay = ({ label, items, stream = process.stdout }) => ({
  startTask(id),
  updateTask(id, loadedBytes),
  noteTask(id, note),          // retry notices render into the bar
  finishTask(id, { error }),
  counts(),                    // { completed, failed }
  stop(),
});
```

`items` is `[{ id, name, totalBytes }]`, the full work list up front. Both call
sites already know it, and having it lets the display render queued rows and a
correct `bytesTotal` instead of discovering the total as it goes.

Repaints on a 100ms timer rather than on every event, so a burst of
`httpUploadProgress` callbacks cannot thrash the terminal. Each repaint moves the
cursor up over the previously drawn block (`ESC[nA`, `ESC[0J`) and rewrites it,
truncating every line to `stream.columns`. The cursor is hidden while running and
restored by `stop()`, which is called from a `finally` so a crash or Ctrl-C does
not leave an invisible cursor.

**Non-TTY** (`!stream.isTTY` — CI, pipes, redirects): `startTask`/`updateTask`
become no-ops and `finishTask` prints one plain line per item. No escape codes
ever reach a log file.

`noteTask` exists specifically because retries must render *into* the display; a
bare `console.warn` mid-repaint interleaves with the redraw and scrambles it.

### `scripts/retry.js` (new)

Lifts `withRetry` out of `upload-photos.js`. Same 4 attempts and 500ms×2ⁿ
backoff; the two `console.warn` calls become an injected callback:

```js
export const withRetry = async (operation, {
  attempts = 4, baseDelayMs = 500, onRetry = () => {},
} = {}) => { /* … */ };
// onRetry({ attempt, attempts, error, backoffMs })
```

The `label` parameter is dropped — the caller's `onRetry` closure already knows
which item it belongs to.

### `scripts/format.js` (new)

`formatBytes` is moved verbatim from `r2.js:21` (`formatSize`), which imports it
instead of keeping a second copy. Adds `formatRate` and `formatDuration` for the
throughput and ETA fields.

### `scripts/upload-photos.js` (rewritten)

- **Deletes its duplicated `createS3Client`** (lines 38–52) and the inline
  `R2_BUCKET_NAME` check, importing `createS3Client` / `getBucketName` from
  `r2client.js`. That is ~20 lines of exact duplication removed.
- **Swaps `PutObjectCommand` over a `readFileSync` buffer** for
  `@aws-sdk/lib-storage`'s `Upload` over a `createReadStream`. This is what
  supplies `httpUploadProgress` (`{ loaded, total }`) to drive the per-file bars,
  and it also means N concurrent uploads no longer hold N whole photos in memory.
- Per-file byte totals come from `statSync(filePath).size`, summed up front for
  the aggregate bar.

The upload body is constructed **inside** the retried closure:

```js
withRetry(() => {
  const upload = new Upload({ client, params: { /* Body: createReadStream(path) */ } });
  upload.on('httpUploadProgress', p => display.updateTask(id, p.loaded ?? 0));
  return upload.done();
}, { onRetry: () => display.updateTask(id, 0) /* + noteTask */ });
```

This matters: a read stream cannot be replayed once consumed, so each attempt
must build a fresh one. Retrying an already-drained stream would silently upload
a zero-byte object. `onRetry` also resets the task's `loaded` to 0 so the bar
snaps back rather than appearing to exceed 100%.

Defaults to **6** concurrent uploads, `--concurrency N` to override. Validation
and arg parsing are unchanged. On completion, failed files are listed and the
process exits 1; a partial batch still reports every success.

### `scripts/process.js` (rewritten loops)

Both phases move onto `mapWithConcurrency` and the shared display. Phase logic,
cache semantics, and `--force` are otherwise unchanged.

The two phases have different defaults because they are bound by different
resources. `--concurrency N`, when given, overrides **both**.

**EXIF phase** — concurrency **8**. These are 128KB range requests, so bars run
in count mode; byte-level bars would be noise.

The periodic cache save needs care under concurrency. Today it saves every 10
sequential items. Concurrent completions can overlap two `saveJson` calls, and
because each serializes the whole `cache` object, an older snapshot can land
last and drop entries. Saves are therefore chained through a single promise:

```js
let pendingSave = Promise.resolve();
const queueSave = () => (pendingSave = pendingSave.then(() => saveJson(/* … */)));
```

Still every 10 completions, plus a final awaited save — but never two in flight.

**Image phase** — concurrency **4**, deliberately lower than uploads. Each photo
holds a full-resolution buffer while sharp produces two derivatives, and sharp is
already multi-threaded across its own libvips pool, so a higher number trades
memory for contention rather than speed.

Download bytes are byte-accurate — sizes are already in the `ListObjectsV2`
results that `processImages` receives. Resize and upload then show as labeled
stages (`resizing`, `uploading`) via `noteTask`.

R2 calls in this script (`downloadObject`, `uploadObject`, `saveJson`) gain
`withRetry`, which they lack today. Concurrency makes transient 5xx/timeout
responses meaningfully more likely, and a failure here currently kills the whole
run.

## Error Handling

- A failed item never aborts the batch. `mapWithConcurrency` settles it, the
  display marks that line failed, and a summary prints after the bars stop.
- Exit code is 1 if any item failed, 0 otherwise.
- `display.stop()` runs in a `finally`, so the cursor and terminal state are
  restored even on an unhandled throw.
- Retry notices route through `noteTask`, never `console.*`, while bars are live.
- Existing pre-flight validation (missing files, unsupported extensions, missing
  credentials) still fails fast before any work starts.

## Testing

`node --test`, following the existing `scripts/*.test.js` convention. Pure units
only — no R2 access, consistent with how `favorites` and `deletePhoto` are tested.

**`concurrency.test.js`**
- Never exceeds `limit` in flight (worker increments/decrements a counter and
  records the observed maximum).
- Results are in input order regardless of completion order.
- A throwing worker yields `{ error }` for that item and does not stop the pool.
- Empty input, and `limit` greater than `items.length`.

**`progress.test.js`**
- `renderBar` at 0, 0.5, 1, and out-of-range fractions (clamped, exact width).
- `renderDisplay` renders active tasks, count-mode tasks, and the total line.
- Rate and ETA derive from the injected `startedAt`/`now` (no clock reads).
- Zero elapsed time does not produce `Infinity` or `NaN` in the rate field.

**`retry.test.js`**
- Succeeds on first attempt without calling `onRetry`.
- Retries to success, with `onRetry` receiving the doubling `backoffMs`.
- Rethrows the last error after `attempts` failures.

**`format.test.js`** — `formatBytes` boundaries (B/KB/MB/GB), `formatDuration`.

The R2-effecting paths and the live ANSI rendering are verified manually against
the real bucket, as with previous work in this repo.

## Files Touched

New: `scripts/concurrency.js`, `scripts/progress.js`, `scripts/retry.js`,
`scripts/format.js`, and their four `*.test.js` counterparts.

Modified: `scripts/upload-photos.js`, `scripts/process.js`, `scripts/r2.js`
(imports `formatBytes`), `package.json` (adds `@aws-sdk/lib-storage`).

Removed: nothing.

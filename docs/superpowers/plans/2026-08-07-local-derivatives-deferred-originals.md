# Local Derivatives with Deferred Originals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/upload-photos.js` resize photos locally and upload only the two derivatives the site actually serves, queueing the full-size originals to a local manifest for a later push on fast wifi.

**Architecture:** Four leaf modules are built and tested bottom-up (`keys.js` extensions, `pendingOriginals.js`, `derivatives.js`, `upload.js`), plus one small change to `progress.js`. The three scripts are then rewritten onto them. Because the original is no longer guaranteed to be in the bucket, photo discovery inverts to key off `.web/`, and EXIF reads from the web derivative when no original exists.

**Tech Stack:** Node 20+ ESM, `node --test`, `sharp` 0.34, `exifr`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`.

## Global Constraints

- **ESM only** — every file uses `import`/`export`, never `require`. `package.json` has `"type": "module"`.
- **Tests** are `node --test`, colocated as `scripts/<name>.test.js`, using `node:test` and `node:assert/strict`. No test framework, no mocking library.
- **Run the whole suite with `npm test`**, never `node --test scripts/` — on Node 22 that resolves `scripts` as a module path and dies with `MODULE_NOT_FOUND` before running anything. A single file is fine: `node --test scripts/keys.test.js`. Baseline at the start of this plan is **65 passing**.
- **Tests must not touch the network, R2, or the filesystem.** Inject `read`/`write`/`stream`/`clock` rather than reaching for the real thing. Generating an in-memory image with `sharp({ create: ... })` is fine — it is pure computation.
- **Style matches the existing repo:** arrow-function consts, named exports, `// ── section ──` banner comments, 2-space indent, semicolons.
- **No new dependencies.** `sharp`, `exifr`, and both AWS SDK packages are already installed.
- **Image parameters are fixed** and must match what is already in the bucket: thumbnail **600px / quality 80**, web **2048px / quality 85**, both JPEG, both keeping the source filename's extension.
- **Concurrency defaults:** **6** for both upload scripts, **8** EXIF, **4** image backfill. `--concurrency N` overrides.
- **Retry policy unchanged:** 4 attempts, 500ms base, doubling.
- **Never call `console.*` while progress bars are live** — notices route through `noteTask`.
- **Derived directory names** are `.thumbnails` and `.web`. They exist in the bucket today; renaming them is out of scope.

## Verified Facts

These were checked empirically against this repo's installed sharp (0.34.5 / libvips 8.17.3) before the plan was written. Do not re-litigate them:

- `keepMetadata()` preserves EXIF through a resize; omitting it strips EXIF. Confirmed by round-tripping `withExif({ IFD0: { Make: 'FUJIFILM' } })` through a 2048px resize and re-parsing with `exifr`.
- **sharp cannot decode HEIC here.** `sharp(heicFile).metadata()` succeeds, but any pixel operation fails with `source: bad seek to <n>` where `n` exceeds the file length. This is true for both file-path and buffer input. HEIC must therefore be rejected at validation.

---

### Task 1: `keys.js` — invert derived keys and discover photos

The pipeline currently finds photos by listing originals. Once originals are deferred, it must find them by their `.web/` derivative too. `process.js:29-36` also duplicates `thumbnailKey`/`webKey` verbatim; that copy goes.

**Files:**
- Modify: `scripts/keys.js`
- Modify: `scripts/keys.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `THUMBNAIL_DIR: string`, `WEB_DIR: string`, `thumbnailKey(key: string) => string` (unchanged), `webKey(key: string) => string` (unchanged), `originalKey(key: string) => string`, `logicalPhotoKeys(keys: string[]) => Set<string>`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/keys.test.js`:

```js
import { originalKey, logicalPhotoKeys } from './keys.js';

// ── originalKey ───────────────────────────────────────────────────────────────

test('originalKey inverts webKey and thumbnailKey', () => {
  assert.equal(originalKey('2025-italy/.web/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey('2025-italy/.thumbnails/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey(webKey('a/b/c.jpg')), 'a/b/c.jpg');
  assert.equal(originalKey(thumbnailKey('a/b/c.jpg')), 'a/b/c.jpg');
});

test('originalKey leaves a key with no derived segment alone', () => {
  assert.equal(originalKey('2025-italy/a.jpg'), '2025-italy/a.jpg');
  assert.equal(originalKey('a.jpg'), 'a.jpg');
});

// ── logicalPhotoKeys ──────────────────────────────────────────────────────────

test('logicalPhotoKeys returns originals that are present in the bucket', () => {
  const keys = logicalPhotoKeys(['2025-italy/a.jpg', '2025-italy/b.png']);
  assert.deepEqual([...keys].sort(), ['2025-italy/a.jpg', '2025-italy/b.png']);
});

test('logicalPhotoKeys infers a photo from its web derivative alone', () => {
  const keys = logicalPhotoKeys(['2025-italy/.web/a.jpg']);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

test('logicalPhotoKeys does not double-count a photo that has both', () => {
  const keys = logicalPhotoKeys([
    '2025-italy/a.jpg',
    '2025-italy/.web/a.jpg',
    '2025-italy/.thumbnails/a.jpg',
  ]);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

test('logicalPhotoKeys does not invent a photo from a thumbnail alone', () => {
  assert.deepEqual([...logicalPhotoKeys(['2025-italy/.thumbnails/a.jpg'])], []);
});

test('logicalPhotoKeys ignores root files, hidden files, and non-images', () => {
  const keys = logicalPhotoKeys([
    'exif-cache.json',
    'favorites.json',
    '2025-italy/.DS_Store',
    '2025-italy/notes.txt',
    '2025-italy/a.jpg',
  ]);
  assert.deepEqual([...keys], ['2025-italy/a.jpg']);
});

// Deliberately broader than the uploader's SUPPORTED_EXTENSIONS (Task 5): this
// discovers what is already in the bucket, including formats uploaded before
// local resizing existed.
test('logicalPhotoKeys accepts every image extension the bucket may contain', () => {
  const keys = logicalPhotoKeys([
    'a/p.jpg', 'a/p.jpeg', 'a/p.png', 'a/p.gif',
    'a/p.webp', 'a/p.avif', 'a/p.heic', 'a/p.heif', 'a/p.tif', 'a/p.tiff',
  ]);
  assert.equal(keys.size, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/keys.test.js`
Expected: FAIL — `The requested module './keys.js' does not provide an export named 'originalKey'`

- [ ] **Step 3: Write the implementation**

Replace the whole of `scripts/keys.js`:

```js
export const THUMBNAIL_DIR = '.thumbnails';
export const WEB_DIR = '.web';

const DERIVED_DIRS = new Set([THUMBNAIL_DIR, WEB_DIR]);

const PHOTO_PATTERN = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?)$/i;

const derivedKey = (dir) => (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, dir, filename].join('/');
};

export const thumbnailKey = derivedKey(THUMBNAIL_DIR);
export const webKey = derivedKey(WEB_DIR);

export const originalKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  const parent = parts.pop();
  return DERIVED_DIRS.has(parent) ? [...parts, filename].join('/') : key;
};

// A photo exists if its original is in the bucket OR its web derivative is —
// uploads now write derivatives first and defer the original, so the web copy
// is what proves the photo exists. A thumbnail alone is not enough: it carries
// no EXIF and cannot stand in for the full-size view.
export const logicalPhotoKeys = (keys) => new Set(
  keys.flatMap((key) => {
    const parts = key.split('/');
    if (parts.length < 2) return [];

    const filename = parts.at(-1);
    if (filename.startsWith('.') || !PHOTO_PATTERN.test(filename)) return [];

    const parent = parts.at(-2);
    if (parent === WEB_DIR) return [originalKey(key)];
    return parent.startsWith('.') ? [] : [key];
  })
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/keys.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/keys.js scripts/keys.test.js
git commit -m "Add originalKey and logicalPhotoKeys for .web-based photo discovery"
```

---

### Task 2: `pendingOriginals.js` — the deferred-originals queue

Originals go into a gitignored manifest at repo root. Every concurrent upload worker appends to it, so the read-modify-write must be serialized or entries get dropped — the same hazard `process.js:127-131` already guards against for the EXIF cache.

**Files:**
- Create: `scripts/pendingOriginals.js`
- Create: `scripts/pendingOriginals.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `PENDING_PATH: string`, `addPending(entries: Entry[], entry: Entry) => Entry[]`, `removePending(entries: Entry[], key: string) => Entry[]`, `parsePending(text: string) => Entry[]`, `createPendingQueue({ read?, write? }) => { load(), add(entry), remove(key) }` where `Entry = { localPath: string, key: string }`. `add` and `remove` return a Promise resolving to the new array.

- [ ] **Step 1: Write the failing test**

Create `scripts/pendingOriginals.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPending, removePending, parsePending, createPendingQueue,
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

test('parsePending returns an array, or empty for anything unusable', () => {
  assert.deepEqual(parsePending('[{"localPath":"/p/a.jpg","key":"album/a.jpg"}]'), [entry('a.jpg')]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/pendingOriginals.test.js`
Expected: FAIL — `Cannot find module '.../scripts/pendingOriginals.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts/pendingOriginals.js`:

```js
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

// ── location ──────────────────────────────────────────────────────────────────

export const PENDING_PATH = fileURLToPath(new URL('../.pending-originals.json', import.meta.url));

// ── pure operations ───────────────────────────────────────────────────────────

export const addPending = (entries, entry) =>
  [...entries.filter(pending => pending.key !== entry.key), entry];

export const removePending = (entries, key) =>
  entries.filter(pending => pending.key !== key);

export const parsePending = (text) => {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// ── queue ─────────────────────────────────────────────────────────────────────

const readFile = () => (existsSync(PENDING_PATH) ? readFileSync(PENDING_PATH, 'utf8') : '[]');
const writeFile = (text) => writeFileSync(PENDING_PATH, text);

export const createPendingQueue = ({ read = readFile, write = writeFile } = {}) => {
  const load = () => parsePending(read());

  // Every upload worker appends to the same manifest. The read AND the write
  // both have to sit inside the chain — reading outside it lets two workers
  // start from the same snapshot and the second write loses the first entry.
  let pending = Promise.resolve();
  const mutate = (change) => {
    pending = pending.then(() => {
      const next = change(load());
      write(JSON.stringify(next, null, 2));
      return next;
    });
    return pending;
  };

  return {
    load,
    add: (entry) => mutate(entries => addPending(entries, entry)),
    remove: (key) => mutate(entries => removePending(entries, key)),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/pendingOriginals.test.js`
Expected: PASS, all tests. The concurrency test is the one that matters — it fails if the read is hoisted out of `mutate`.

- [ ] **Step 5: Add the manifest to `.gitignore`**

Under the existing `# Generated data` section in `.gitignore`, after the `src/data/photos.json` line, add:

```
.pending-originals.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/pendingOriginals.js scripts/pendingOriginals.test.js .gitignore
git commit -m "Add pending-originals queue with serialized read-modify-write"
```

---

### Task 3: `progress.js` — let byte totals arrive late

`bytesTotal` is captured once at construction (`progress.js:88`). Derivative sizes are not known until after the resize, so the total has to be summed from the tasks on each snapshot instead.

**Files:**
- Modify: `scripts/progress.js:88` and `scripts/progress.js:97-108`, `scripts/progress.js:136-139`
- Modify: `scripts/progress.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createProgressDisplay(...)` gains `setTaskTotal(id: string, total: number) => void`. `renderDisplay` and `renderBar` are unchanged — `renderDisplay` still reads `bytesTotal` off the state it is handed.

- [ ] **Step 1: Write the failing test**

Append to `scripts/progress.test.js`, in the `createProgressDisplay` section:

```js
test('setTaskTotal switches a task to a byte bar and feeds the aggregate total', () => {
  const stream = fakeStream({ isTTY: true });
  let now = 0;
  const display = createProgressDisplay({
    label: 'Uploading',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: null }],
    stream,
    clock: () => now,
  });

  display.startTask('a');
  display.setTaskTotal('a', 4 * 1024 ** 2);
  display.updateTask('a', 1024 ** 2);
  now = 2000;
  display.stop();

  const output = stream.writes.join('');
  assert.match(output, /1\.0 MB \/ 4\.0 MB/);
  // 1 MB in 2 s = 0.5 MB/s; 3 MB remaining = 6 s. An eta at all proves
  // bytesTotal came from the task rather than the construction-time sum of 0.
  assert.match(output, /eta 6s/);
});

test('a task with no total yet still renders in count mode', () => {
  const stream = fakeStream({ isTTY: true });
  const display = createProgressDisplay({
    label: 'Uploading',
    items: [{ id: 'a', name: 'a.jpg', totalBytes: null }],
    stream,
    clock: () => 0,
  });

  display.startTask('a');
  display.noteTask('a', 'resizing');
  display.stop();

  const output = stream.writes.join('');
  assert.match(output, /resizing/);
  assert.doesNotMatch(output, /a\.jpg.*%/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/progress.test.js`
Expected: FAIL — `display.setTaskTotal is not a function`

- [ ] **Step 3: Write the implementation**

In `scripts/progress.js`, delete the `bytesTotal` const (line 88):

```js
  const bytesTotal = items.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0);
```

In `snapshot()`, replace the `bytesTotal` field so it is summed from the tasks alongside `bytesDone`:

```js
  const snapshot = () => ({
    label,
    total: items.length,
    completed,
    failed,
    bytesDone: [...tasks.values()].reduce((sum, task) => sum + task.loaded, 0),
    // Summed per snapshot, not captured up front: upload-photos.js only learns
    // a photo's byte total once its derivatives have been resized.
    bytesTotal: [...tasks.values()].reduce((sum, task) => sum + (task.total ?? 0), 0),
    startedAt,
    now: clock(),
    maxRows,
    tasks: [...tasks.values()],
  });
```

In the returned object, add `setTaskTotal` next to `updateTask`:

```js
    startTask: (id) => patch(id, { state: 'active', note: null }),
    setTaskTotal: (id, total) => patch(id, { total }),
    updateTask: (id, loaded) => patch(id, { loaded }),
    noteTask: (id, note) => patch(id, { note }),
```

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. The pre-existing `renderDisplay` tests must still pass untouched — they pass `bytesTotal` in explicitly and that path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/progress.js scripts/progress.test.js
git commit -m "Sum progress byte totals per snapshot so they can arrive late"
```

---

### Task 4: `derivatives.js` — one definition of thumbnail and web

`process.js:179-186` owns the only resize definitions today. `upload-photos.js` is about to need the same ones, and two copies drifting apart would silently produce mismatched derivatives depending on which path created a photo.

The web derivative gains `keepMetadata()`. This is the load-bearing change in the whole plan: sharp strips EXIF by default, and once the original is deferred the web image is the only copy of the metadata in the bucket.

**Files:**
- Create: `scripts/derivatives.js`
- Create: `scripts/derivatives.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `THUMBNAIL_WIDTH: number`, `WEB_WIDTH: number`, `makeThumbnail(buffer: Buffer) => Promise<Buffer>`, `makeWebSized(buffer: Buffer) => Promise<Buffer>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/derivatives.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import exifr from 'exifr';
import { makeThumbnail, makeWebSized, THUMBNAIL_WIDTH, WEB_WIDTH } from './derivatives.js';

// Generated in memory rather than read from disk, so the suite stays pure.
const sourcePhoto = ({ width = 4000, height = 3000 } = {}) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .withExif({ IFD0: { Make: 'FUJIFILM', Model: 'X-T5' } })
    .jpeg()
    .toBuffer();

test('makeWebSized resizes to the web width', async () => {
  const web = await makeWebSized(await sourcePhoto());
  const { width, format } = await sharp(web).metadata();

  assert.equal(width, WEB_WIDTH);
  assert.equal(format, 'jpeg');
});

test('makeThumbnail resizes to the thumbnail width', async () => {
  const thumbnail = await makeThumbnail(await sourcePhoto());
  const { width, format } = await sharp(thumbnail).metadata();

  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(format, 'jpeg');
});

test('makeWebSized preserves EXIF — it is the only metadata copy for a deferred original', async () => {
  const web = await makeWebSized(await sourcePhoto());
  const exif = await exifr.parse(web, { pick: ['Make', 'Model'] });

  assert.equal(exif.Make, 'FUJIFILM');
  assert.equal(exif.Model, 'X-T5');
});

test('makeThumbnail drops EXIF', async () => {
  const thumbnail = await makeThumbnail(await sourcePhoto());

  assert.equal(await exifr.parse(thumbnail, { pick: ['Make'] }), undefined);
});

test('neither derivative enlarges a photo smaller than its target', async () => {
  const small = await sourcePhoto({ width: 400, height: 300 });

  assert.equal((await sharp(await makeWebSized(small)).metadata()).width, 400);
  assert.equal((await sharp(await makeThumbnail(small)).metadata()).width, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/derivatives.test.js`
Expected: FAIL — `Cannot find module '.../scripts/derivatives.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts/derivatives.js`:

```js
import sharp from 'sharp';

export const THUMBNAIL_WIDTH = 600;
export const WEB_WIDTH = 2048;

const resizeTo = (width, quality, keepMetadata = false) => (buffer) => {
  const pipeline = sharp(buffer)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality });

  return (keepMetadata ? pipeline.keepMetadata() : pipeline).toBuffer();
};

export const makeThumbnail = resizeTo(THUMBNAIL_WIDTH, 80);

// EXIF is kept here and only here. When the original upload is deferred, this
// derivative is the only copy of the metadata in the bucket, and process.js
// range-reads it from exactly this file. A 600px thumbnail has no such duty.
export const makeWebSized = resizeTo(WEB_WIDTH, 85, true);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/derivatives.test.js`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/derivatives.js scripts/derivatives.test.js
git commit -m "Extract shared derivative sizes and keep EXIF in the web image"
```

---

### Task 5: `upload.js` — one retrying upload for buffers and streams

`upload-photos.js:52` has the only upload helper. It hardcodes a `createReadStream` body; the new derivative path needs to send in-memory buffers instead, and the deferred-originals script still needs the stream. One function with an injected body factory serves both, and the factory is what makes the retry correct in either case.

**Files:**
- Create: `scripts/upload.js`
- Create: `scripts/upload.test.js`

**Interfaces:**
- Consumes: `withRetry` from `./retry.js`.
- Produces: `SUPPORTED_EXTENSIONS: Set<string>`, `contentTypeFor(filePath: string) => string`, `uploadToR2(client, bucketName: string, { key: string, contentType: string, createBody: () => Buffer|Stream }, hooks: { onAttemptStart?, onProgress?, onRetry? }) => Promise<void>`.

Note `.heic` and `.heif` are deliberately **absent** from `SUPPORTED_EXTENSIONS` — see Task 6.

- [ ] **Step 1: Write the failing test**

Create `scripts/upload.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, SUPPORTED_EXTENSIONS } from './upload.js';

test('contentTypeFor maps known image extensions', () => {
  assert.equal(contentTypeFor('/photos/a.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('/photos/a.JPEG'), 'image/jpeg');
  assert.equal(contentTypeFor('/photos/a.png'), 'image/png');
  assert.equal(contentTypeFor('/photos/a.webp'), 'image/webp');
  assert.equal(contentTypeFor('/photos/a.avif'), 'image/avif');
});

test('contentTypeFor falls back to a generic type', () => {
  assert.equal(contentTypeFor('/photos/a.xyz'), 'application/octet-stream');
});

test('SUPPORTED_EXTENSIONS excludes heic and heif — sharp here cannot decode them', () => {
  assert.equal(SUPPORTED_EXTENSIONS.has('.heic'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.heif'), false);
  assert.equal(SUPPORTED_EXTENSIONS.has('.jpg'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/upload.test.js`
Expected: FAIL — `Cannot find module '.../scripts/upload.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts/upload.js`:

```js
import { Upload } from '@aws-sdk/lib-storage';
import { extname } from 'path';
import { withRetry } from './retry.js';

// ── content types ─────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

// .heic/.heif are absent on purpose: this repo's sharp reads their metadata but
// cannot decode their pixels, and a photo we cannot resize is a photo we cannot
// publish now that only derivatives are uploaded up front.
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export const contentTypeFor = (filePath) =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';

// ── upload ────────────────────────────────────────────────────────────────────

// createBody is a factory, not a value, because a read stream cannot be replayed
// once consumed — a retry that reused one would silently upload a zero-byte
// object. Buffer callers can safely return the same buffer every time.
export const uploadToR2 = (client, bucketName, { key, contentType, createBody }, hooks = {}) =>
  withRetry(() => {
    hooks.onAttemptStart?.();

    const upload = new Upload({
      client,
      params: { Bucket: bucketName, Key: key, Body: createBody(), ContentType: contentType },
    });

    upload.on('httpUploadProgress', ({ loaded }) => hooks.onProgress?.(loaded ?? 0));
    return upload.done();
  }, { onRetry: hooks.onRetry });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/upload.test.js`
Expected: PASS, all three tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload.js scripts/upload.test.js
git commit -m "Extract uploadToR2 with an injected body factory for buffers and streams"
```

---

### Task 6: `upload-photos.js` — resize locally, upload small, queue the original

The change that makes remote uploads fast. Instead of streaming a ~12MB original, the worker resizes in memory and uploads ~560KB of derivatives, then records the original for later.

**Files:**
- Modify: `scripts/upload-photos.js` (rewrite lines 1-113; `parseArgs` keeps its behaviour)
- Modify: `scripts/upload-photos.test.js`

**Interfaces:**
- Consumes: `makeThumbnail`/`makeWebSized` (Task 4), `uploadToR2`/`contentTypeFor`/`SUPPORTED_EXTENSIONS` (Task 5), `thumbnailKey`/`webKey` (Task 1), `createPendingQueue` (Task 2), `setTaskTotal` (Task 3).
- Produces: `parseArgs(args: string[]) => { folder, files, concurrency }` (unchanged), `validateFiles(files: string[]) => void` (now exported).

- [ ] **Step 1: Write the failing test**

Replace `scripts/upload-photos.test.js` with the existing `parseArgs` tests plus new `validateFiles` cases:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, validateFiles } from './upload-photos.js';

// ── parseArgs (unchanged behaviour) ───────────────────────────────────────────

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

// ── validateFiles ─────────────────────────────────────────────────────────────

test('validateFiles reports a missing file', () => {
  assert.throws(() => validateFiles(['/nope/missing.jpg']), /File not found: \/nope\/missing\.jpg/);
});

test('validateFiles rejects heic with an actionable message', () => {
  assert.throws(
    () => validateFiles(['/nope/photo.heic']),
    /cannot be resized locally.*[Cc]onvert/s,
  );
});

test('validateFiles reports an unsupported extension', () => {
  assert.throws(() => validateFiles(['/nope/notes.txt']), /Unsupported file type/);
});
```

Note: the HEIC and unsupported-extension assertions fire on the extension check before the existence check is reached for those paths — order the implementation accordingly (see Step 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/upload-photos.test.js`
Expected: FAIL — `does not provide an export named 'validateFiles'`

- [ ] **Step 3: Write the implementation**

Replace `scripts/upload-photos.js` entirely:

```js
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { makeThumbnail, makeWebSized } from './derivatives.js';
import { uploadToR2, SUPPORTED_EXTENSIONS } from './upload.js';
import { thumbnailKey, webKey } from './keys.js';
import { createPendingQueue } from './pendingOriginals.js';

// ── constants ─────────────────────────────────────────────────────────────────

const UNDECODABLE_EXTENSIONS = new Set(['.heic', '.heif']);

const DEFAULT_CONCURRENCY = 6;

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] <folder> <file1> [file2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

export const parseArgs = (args) => {
  const { concurrency, rest } = parseConcurrencyFlag(args);
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...files] = rest;
  return { folder, files, concurrency: concurrency ?? DEFAULT_CONCURRENCY };
};

export const validateFiles = (files) => {
  const errors = files.flatMap((file) => {
    const ext = extname(file).toLowerCase();

    if (UNDECODABLE_EXTENSIONS.has(ext)) {
      return [`${file} cannot be resized locally (${ext} decoding is unavailable). ` +
              `Convert it to JPEG first, e.g. \`sips -s format jpeg "${file}" --out "${file.replace(/\.[^.]+$/, '.jpg')}"\`.`];
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) return [`Unsupported file type: ${file} (${ext})`];
    if (!existsSync(file)) return [`File not found: ${file}`];
    return [];
  });

  if (errors.length > 0) throw new Error(errors.join('\n'));
};

// ── upload ────────────────────────────────────────────────────────────────────

// Both derivatives upload at once, so the task's byte count is the sum of two
// independent progress streams. Each one reports an absolute `loaded`, so they
// are tracked separately and summed rather than added as they arrive.
const createByteTracker = (report) => {
  const loaded = { thumbnail: 0, web: 0 };
  return (which) => (bytes) => {
    loaded[which] = bytes;
    report(loaded.thumbnail + loaded.web);
  };
};

const uploadPhoto = async (client, bucketName, item, hooks) => {
  const original = await readFile(item.filePath);

  hooks.onNote('resizing');
  const [thumbnail, web] = await Promise.all([makeThumbnail(original), makeWebSized(original)]);

  hooks.onTotal(thumbnail.length + web.length);
  hooks.onNote('uploading');

  const track = createByteTracker(hooks.onProgress);
  const send = (which, key, body) => uploadToR2(client, bucketName, {
    key,
    contentType: 'image/jpeg',
    createBody: () => body,
  }, {
    onProgress: track(which),
    onRetry: ({ attempt, attempts }) => {
      track(which)(0);
      hooks.onNote(`retry ${attempt}/${attempts - 1}`);
    },
  });

  await Promise.all([
    send('thumbnail', thumbnailKey(item.key), thumbnail),
    send('web', webKey(item.key), web),
  ]);
};

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const { folder, files, concurrency } = parseArgs(process.argv.slice(2));
  validateFiles(files);

  const client = createS3Client();
  const bucketName = getBucketName();
  const queue = createPendingQueue();

  const items = files.map(filePath => ({
    id: filePath,
    filePath,
    name: basename(filePath),
    key: `${folder}/${basename(filePath)}`,
    // Byte totals arrive after the resize — the original's size on disk is not
    // a quantity this script uploads any more.
    totalBytes: null,
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
        await uploadPhoto(client, bucketName, item, {
          onNote: (note) => display.noteTask(item.id, note),
          onTotal: (total) => display.setTaskTotal(item.id, total),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
        });
        // Queued only after both derivatives land. A photo whose images failed
        // is one to re-run whole, not one to leave queued with nothing in R2.
        await queue.add({ localPath: resolve(item.filePath), key: item.key });
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
  console.log(`${queue.load().length} original(s) queued — run \`npm run upload:originals\` on fast wifi.`);

  if (failures.length > 0) {
    console.error('\nFailed:');
    for (const failure of failures) {
      console.error(`  ${failure.item.key}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }
};

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  run().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/upload-photos.test.js`
Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload-photos.js scripts/upload-photos.test.js
git commit -m "Resize photos locally and upload only derivatives, queueing originals"
```

---

### Task 7: `upload-originals.js` — drain the queue on fast wifi

**Files:**
- Create: `scripts/upload-originals.js`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `createPendingQueue` (Task 2), `uploadToR2`/`contentTypeFor` (Task 5), `mapWithConcurrency`/`parseConcurrencyFlag`, `createProgressDisplay`.
- Produces: nothing importable — this is a CLI entry point.

- [ ] **Step 1: Write the implementation**

There is no new pure logic here — the queue is covered by Task 2 and the upload by Task 5, and everything remaining is R2 I/O, which this repo verifies manually. Create `scripts/upload-originals.js`:

```js
import { createReadStream, existsSync, statSync } from 'fs';
import { basename } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { uploadToR2, contentTypeFor } from './upload.js';
import { createPendingQueue } from './pendingOriginals.js';

const DEFAULT_CONCURRENCY = 6;

const run = async () => {
  const { concurrency } = parseConcurrencyFlag(process.argv.slice(2));
  const queue = createPendingQueue();
  const pending = queue.load();

  if (pending.length === 0) {
    console.log('No originals pending.');
    return;
  }

  const missing = pending.filter(entry => !existsSync(entry.localPath));
  const ready = pending.filter(entry => existsSync(entry.localPath));

  // A moved or deleted original will never upload. Report it once and drop it
  // rather than re-reporting it on every future run.
  for (const entry of missing) {
    console.warn(`Dropping ${entry.key} — no longer at ${entry.localPath}`);
    await queue.remove(entry.key);
  }

  if (ready.length === 0) {
    console.log('Nothing left to upload.');
    return;
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  const items = ready.map(entry => ({
    id: entry.key,
    key: entry.key,
    localPath: entry.localPath,
    name: basename(entry.localPath),
    totalBytes: statSync(entry.localPath).size,
  }));

  const display = createProgressDisplay({
    label: `Uploading ${items.length} original(s)`,
    items,
  });

  let results;
  try {
    results = await mapWithConcurrency(items, concurrency ?? DEFAULT_CONCURRENCY, async (item) => {
      display.startTask(item.id);

      try {
        await uploadToR2(client, bucketName, {
          key: item.key,
          contentType: contentTypeFor(item.localPath),
          createBody: () => createReadStream(item.localPath),
        }, {
          onAttemptStart: () => display.updateTask(item.id, 0),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
          onRetry: ({ attempt, attempts }) => {
            display.updateTask(item.id, 0);
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);
          },
        });
        // Removed one at a time as each lands, so Ctrl-C leaves an accurate
        // manifest and a re-run resumes instead of restarting.
        await queue.remove(item.key);
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
  console.log(`\n${results.length - failures.length}/${results.length} original(s) uploaded.`);
  console.log(`${queue.load().length} still pending.`);

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

- [ ] **Step 2: Add the npm script**

In `package.json`, add after the `"upload"` line:

```json
    "upload:originals": "node scripts/upload-originals.js",
```

- [ ] **Step 3: Verify it handles an empty queue**

Run: `npm run upload:originals`
Expected: prints `No originals pending.` and exits 0 (assuming no manifest exists yet). This confirms the module loads and every import resolves.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — nothing here should have disturbed existing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload-originals.js package.json
git commit -m "Add upload:originals to drain the deferred-originals queue"
```

---

### Task 8: `process.js` — backfill only, and read EXIF from the web copy

Photos uploaded through the new path arrive complete and must skip the image phase entirely. Photos already in the bucket as originals-only still need it. And EXIF must fall back to the web derivative when there is no original to range-read.

**Files:**
- Modify: `scripts/process.js` — delete lines 11-14 and 29-36 and 179-186, rewrite `processImages` selection (line 188-197), rewrite `run` (line 274-294), adjust `fetchExifChunk`/`processExif` for the URL source.

**Interfaces:**
- Consumes: `THUMBNAIL_DIR`/`WEB_DIR`/`thumbnailKey`/`webKey`/`logicalPhotoKeys` (Task 1), `makeThumbnail`/`makeWebSized` (Task 4).
- Produces: nothing importable — CLI entry point.

- [ ] **Step 1: Replace the constants and local key helpers**

In `scripts/process.js`, delete these lines:

```js
const THUMBNAIL_DIR = '.thumbnails';
const THUMBNAIL_WIDTH = 600;
const WEB_DIR = '.web';
const WEB_WIDTH = 2048;
```

and the whole `isPhoto` function (lines 22-27) and this block (lines 29-36):

```js
const derivedKey = (dir) => (key) => { /* … */ };
const thumbnailKey = derivedKey(THUMBNAIL_DIR);
const webKey = derivedKey(WEB_DIR);
```

and the resize block (lines 179-186):

```js
const resizeTo = (width, quality) => (buffer) => /* … */;
const makeThumbnail = resizeTo(THUMBNAIL_WIDTH, 80);
const makeWebSized = resizeTo(WEB_WIDTH, 85);
```

Then update the imports at the top of the file:

```js
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';
import { thumbnailKey, webKey, logicalPhotoKeys } from './keys.js';
import { makeThumbnail, makeWebSized } from './derivatives.js';
```

The `sharp` import is no longer needed here — `derivatives.js` owns it now. `THUMBNAIL_DIR`/`WEB_DIR` are **not** imported: their only uses were `isPhoto` and the two `existing*` filters, all of which are deleted in Steps 1 and 3. Keep the remaining constants:

```js
const EXIF_CACHE_KEY = 'exif-cache.json';
const EXIF_FETCH_BYTES = 131072; // 128KB — enough for EXIF in any JPEG
const EXIF_CONCURRENCY = 8;
const IMAGE_CONCURRENCY = 4;
```

- [ ] **Step 2: Point EXIF at whichever copy exists**

`processExif` currently derives the URL from the photo key directly. Change `fetchExifChunk` to take a full key, and have `processExif` accept a resolver. Replace `fetchExifChunk` (line 81) and the `processExif` signature and its item construction:

```js
const fetchExifChunk = async (publicUrl, key) => {
  const response = await fetch(`${publicUrl}/${key}`, {
    headers: { Range: `bytes=0-${EXIF_FETCH_BYTES - 1}` },
  });
  return Buffer.from(await response.arrayBuffer());
};
```

That function is unchanged. In `processExif`, change the signature to take `exifSourceKey` and use it at the fetch site:

```js
const processExif = async (client, bucketName, photoKeys, publicUrl, force, concurrency, exifSourceKey) => {
```

and inside the worker, replace the fetch call:

```js
        const buffer = await withRetry(() => fetchExifChunk(publicUrl, exifSourceKey(item.id)), {
          onRetry: ({ attempt, attempts }) =>
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`),
        });
```

Everything else in `processExif` — the cache, the chained saves, `--force` — is unchanged. The cache stays keyed by the **original** key regardless of which file the bytes came from.

- [ ] **Step 3: Restrict the image phase to photos that have an original**

Replace the opening of `processImages` (lines 188-197):

```js
const processImages = async (client, bucketName, photoKeys, objects, concurrency) => {
  console.log('\n── Image processing ─────────────────────────────────────────');

  const presentKeys = new Set(objects.map(o => o.Key));
  const sizeByKey = new Map(objects.map(o => [o.Key, o.Size]));

  // Only photos whose original is actually in the bucket can be processed here —
  // this phase downloads the original to resize it. A photo whose original is
  // still queued locally already arrived with both derivatives, so it has
  // nothing to do; including it would just fail with NoSuchKey every run.
  const photosNeedingWork = photoKeys.filter(key =>
    presentKeys.has(key) &&
    (!presentKeys.has(thumbnailKey(key)) || !presentKeys.has(webKey(key)))
  );

  if (photosNeedingWork.length === 0) {
    console.log('All thumbnails and web-sized photos up to date.');
    return;
  }
```

Then inside the worker, replace the two `existingThumbnails`/`existingWebPhotos` lookups (lines 231-232) with `presentKeys`:

```js
        const needsThumbnail = !presentKeys.has(thumbnailKey(item.id));
        const needsWeb = !presentKeys.has(webKey(item.id));
```

The rest of the worker — download, resize, upload, retry, display — is unchanged.

- [ ] **Step 4: Rewrite `run` to use logical keys**

Replace `run` (lines 274-294):

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
  const presentKeys = new Set(objects.map(o => o.Key));
  const photoKeys = [...logicalPhotoKeys(objects.map(o => o.Key))].sort();
  console.log(`Found ${photoKeys.length} photos`);

  // The original is the richer source, so prefer it. When it is still queued
  // locally, the web derivative carries the EXIF that keepMetadata() kept.
  const exifSourceKey = (key) => (presentKeys.has(key) ? key : webKey(key));

  await processExif(
    client, bucketName, photoKeys, publicUrl, force,
    concurrency ?? EXIF_CONCURRENCY, exifSourceKey,
  );
  await processImages(client, bucketName, photoKeys, objects, concurrency ?? IMAGE_CONCURRENCY);

  console.log('\nAll done!');
};
```

- [ ] **Step 5: Verify it runs clean against the real bucket**

Run: `npm run process`
Expected: lists objects, reports the same photo count as before the change, reports the EXIF cache as fully populated (`All photos cached, nothing to do.`), and reports `All thumbnails and web-sized photos up to date.` No failures, exit 0.

This is the regression check that matters: an unchanged bucket must produce no work.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/process.js
git commit -m "Restrict image processing to backfill and read EXIF from the web copy"
```

---

### Task 9: `fetch-photos.js` — build the site from logical photo keys

`parseObjects` iterates raw bucket objects and skips dot-prefixed filenames, so an album whose originals are still queued renders empty. It must iterate logical keys instead.

**Files:**
- Modify: `scripts/fetch-photos.js` — rewrite `parseObjects` (lines 82-160), export it, and guard the entry point (line 210)
- Create: `scripts/fetch-photos.test.js`

**Interfaces:**
- Consumes: `logicalPhotoKeys`/`thumbnailKey`/`webKey` (Task 1).
- Produces: `parseObjects(objects, publicUrl, exifCache, albumCovers, lensOverrides) => Album[]` (now exported).

- [ ] **Step 1: Write the failing test**

Create `scripts/fetch-photos.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObjects } from './fetch-photos.js';

const PUBLIC = 'https://cdn.test';

const object = (Key, LastModified = new Date('2026-01-01T00:00:00Z')) => ({ Key, LastModified });

const parse = (objects, { exif = {}, covers = {}, lenses = {} } = {}) =>
  parseObjects(objects, PUBLIC, exif, covers, lenses);

test('parseObjects builds an album from an original with both derivatives', () => {
  const [album] = parse([
    object('2026-italy/a.jpg'),
    object('2026-italy/.thumbnails/a.jpg'),
    object('2026-italy/.web/a.jpg'),
  ]);

  assert.equal(album.id, '2026-italy');
  assert.equal(album.name, 'Italy');
  assert.equal(album.year, '2026');
  assert.equal(album.photos.length, 1);
  assert.equal(album.photos[0].url, `${PUBLIC}/2026-italy/a.jpg`);
  assert.equal(album.photos[0].thumbnail, `${PUBLIC}/2026-italy/.thumbnails/a.jpg`);
  assert.equal(album.photos[0].web, `${PUBLIC}/2026-italy/.web/a.jpg`);
});

test('parseObjects includes a photo whose original is still queued locally', () => {
  const [album] = parse([
    object('2026-italy/.thumbnails/a.jpg'),
    object('2026-italy/.web/a.jpg'),
  ]);

  assert.equal(album.photos.length, 1);
  // url keeps pointing at the original key even before that object exists —
  // favorites, covers, and lens overrides are all keyed off it.
  assert.equal(album.photos[0].url, `${PUBLIC}/2026-italy/a.jpg`);
  assert.equal(album.photos[0].web, `${PUBLIC}/2026-italy/.web/a.jpg`);
});

test('parseObjects dates a deferred photo from its web derivative', () => {
  const [album] = parse([
    object('2026-italy/.web/a.jpg', new Date('2026-03-04T05:06:07Z')),
  ]);

  assert.equal(album.photos[0].date, '2026-03-04T05:06:07.000Z');
});

test('parseObjects prefers EXIF date over object modification time', () => {
  const [album] = parse([object('2026-italy/a.jpg')], {
    exif: { '2026-italy/a.jpg': { dateTaken: '2025-09-09T00:00:00.000Z', camera: 'X-T5' } },
  });

  assert.equal(album.photos[0].date, '2025-09-09T00:00:00.000Z');
  assert.equal(album.photos[0].camera, 'X-T5');
});

test('parseObjects ignores root files and non-images', () => {
  const albums = parse([
    object('exif-cache.json'),
    object('2026-italy/notes.txt'),
    object('2026-italy/a.jpg'),
  ]);

  assert.equal(albums.length, 1);
  assert.equal(albums[0].photos.length, 1);
});

test('parseObjects sorts albums newest first and honours a configured cover', () => {
  const albums = parse([
    object('2025-japan/z.jpg', new Date('2025-05-01T00:00:00Z')),
    object('2025-japan/a.jpg', new Date('2025-04-01T00:00:00Z')),
    object('2026-italy/a.jpg', new Date('2026-01-01T00:00:00Z')),
  ], { covers: { '2025-japan': 'z.jpg' } });

  assert.deepEqual(albums.map(album => album.id), ['2026-italy', '2025-japan']);
  assert.equal(albums[1].cover, `${PUBLIC}/2025-japan/z.jpg`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/fetch-photos.test.js`
Expected: FAIL — `does not provide an export named 'parseObjects'`, and/or the import triggers `generateMetadata()` and errors on missing R2 credentials. Both are fixed in Step 3.

- [ ] **Step 3: Write the implementation**

In `scripts/fetch-photos.js`, add the import near the top, alongside the existing ones:

```js
import { thumbnailKey, webKey, logicalPhotoKeys } from './keys.js';
```

Replace `parseObjects` (lines 82-160) entirely:

```js
export const parseObjects = (objects, publicUrl, exifCache, albumCovers, lensOverrides) => {
  const presentKeys = new Set(objects.map(o => o.Key));
  const modifiedByKey = new Map(objects.map(o => [o.Key, o.LastModified]));

  // Sorted so albums keep the lexicographic photo order the bucket listing used
  // to give them — album.photos[0] is the default cover and the album date.
  const photoKeys = [...logicalPhotoKeys(objects.map(o => o.Key))].sort();

  const albumMap = new Map();

  photoKeys.forEach(key => {
    const [albumSlug, ...filenameParts] = key.split('/');
    const filename = filenameParts.join('/');

    if (!albumMap.has(albumSlug)) {
      albumMap.set(albumSlug, {
        id: albumSlug,
        name: formatAlbumName(albumSlug),
        year: extractYearFromSlug(albumSlug),
        photos: [],
      });
    }

    const thumbKey = thumbnailKey(key);
    const wKey = webKey(key);

    // The original may not be uploaded yet, so fall back through the derivatives
    // rather than assuming it is there.
    const displayKey = presentKeys.has(key) ? key : wKey;
    const thumbnail = buildPhotoUrl(publicUrl, presentKeys.has(thumbKey) ? thumbKey : displayKey);
    const web = buildPhotoUrl(publicUrl, presentKeys.has(wKey) ? wKey : displayKey);

    const modified = modifiedByKey.get(key) ?? modifiedByKey.get(wKey) ?? null;

    const exif = exifCache[key] || {};
    const album = albumMap.get(albumSlug);
    album.photos.push({
      // Stays the original's URL even before that object exists: favorites.json,
      // album-covers.json, and lens-overrides.json are all keyed off it, and
      // PhotoGrid uses it only as identity.
      url: buildPhotoUrl(publicUrl, key),
      thumbnail,
      web,
      filename,
      date: exif.dateTaken || (modified ? modified.toISOString() : null),
      camera: exif.camera || null,
      aperture: exif.aperture || null,
      shutter: exif.shutter || null,
      iso: exif.iso || null,
      ...photoLensFields(exif, lensOverrides[key]),
    });
  });

  return Array.from(albumMap.values())
    .map(album => {
      const coverFilename = albumCovers[album.id];
      const coverPhoto = coverFilename
        ? album.photos.find(p => p.filename === coverFilename) ?? album.photos[0]
        : album.photos[0];
      return {
        ...album,
        cover: coverPhoto?.thumbnail ?? null,
        firstPhotoDate: album.photos.length > 0 ? album.photos[0].date : null,
        cameras: [...new Set(album.photos.map(p => p.camera).filter(Boolean))],
        lenses: [...new Set(album.photos.map(p => p.lens).filter(Boolean))],
      };
    })
    .sort((a, b) => {
      const da = a.firstPhotoDate ? new Date(a.firstPhotoDate) : new Date(0);
      const db = b.firstPhotoDate ? new Date(b.firstPhotoDate) : new Date(0);
      return db - da;
    });
};
```

Then replace the bare call at line 210 with the entry-point guard this repo already uses in `upload-photos.js:130`:

```js
const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  generateMetadata().catch(error => {
    console.error('Error generating metadata:', error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/fetch-photos.test.js`
Expected: PASS, all six tests.

- [ ] **Step 5: Verify the real build is unchanged**

```bash
cp src/data/photos.json /tmp/photos-before.json
npm run build:photos
diff /tmp/photos-before.json src/data/photos.json && echo "IDENTICAL"
```

Expected: `IDENTICAL`. The bucket has not changed, so the generated metadata must not either. If the diff is non-empty, inspect it before continuing — the only acceptable difference is the disappearance of a non-image file that was previously listed as a photo.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-photos.js scripts/fetch-photos.test.js
git commit -m "Build album metadata from logical photo keys so deferred photos appear"
```

---

### Task 10: End-to-end verification against the real bucket

Every prior task verified a unit. This one verifies the actual behaviour the whole plan exists for, using a throwaway album that is deleted afterwards.

**Files:** none — this is a manual verification task.

- [ ] **Step 1: Pick a test photo and note its size**

```bash
ls -lh <path-to-a-real-jpg>
```

Record the byte count. This is the number the change is supposed to avoid sending.

- [ ] **Step 2: Upload it to a throwaway album**

```bash
npm run upload -- zz-upload-test <path-to-a-real-jpg>
```

Expected: the bar shows `resizing`, then a byte total in the hundreds of KB — **not** the original's size. Final line reports `1 original(s) queued`.

- [ ] **Step 3: Confirm the manifest**

```bash
cat .pending-originals.json
```

Expected: one entry with an absolute `localPath` and `key: "zz-upload-test/<filename>.jpg"`.

- [ ] **Step 4: Confirm the album appears with no original in the bucket**

```bash
npm run build:photos
node -e "
const d = require('./src/data/photos.json');
const a = d.albums.find(x => x.id === 'zz-upload-test');
console.log(JSON.stringify(a.photos[0], null, 2));
"
```

Expected: the photo is present, `thumbnail` and `web` point at `.thumbnails/` and `.web/`, and `camera`/`date` are populated — proving `keepMetadata()` carried the EXIF and `process.js` read it from the web copy. If `camera` is null, run `npm run process` first and re-check.

- [ ] **Step 5: Confirm `process.js` finds no work for it**

```bash
npm run process
```

Expected: the new photo does **not** appear in the image phase. It arrived complete.

- [ ] **Step 6: Drain the queue**

```bash
npm run upload:originals
```

Expected: uploads the full-size original at its real size, reports `1/1`, `0 still pending`, and leaves `.pending-originals.json` as `[]`.

- [ ] **Step 7: Confirm re-running is a no-op**

```bash
npm run upload:originals
```

Expected: `No originals pending.`, exit 0.

- [ ] **Step 8: Clean up the test album**

```bash
npm run r2 -- rm zz-upload-test
npm run build:photos
```

`r2 rm` detects that the key is an album prefix and deletes every object under it, including the derivatives. Confirm with `npm run r2 -- ls zz-upload-test`, which should print `(no objects found)`.

- [ ] **Step 9: Final full-suite run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Update the docs**

In `CLAUDE.md`, the Commands block and the Architecture section both describe the old flow. Replace the commands block with:

```bash
npm run dev              # Start local dev server (Vite)
npm run upload           # <folder> <files...> — resize locally, upload derivatives, queue originals
npm run upload:originals # Drain queued full-size originals (run on fast wifi)
npm run process          # Backfill derivatives/EXIF for photos already in R2
npm run build:photos     # Fetch photo metadata from R2 → src/data/photos.json
npm run build:site       # Compile React app with Vite → dist/
npm run build            # Run both build steps (required before preview/deploy)
npm run preview          # Preview production build locally
```

And in the Architecture section, replace the trailing note under Data Shape:

```
Note: `url` points at the full-size original, which may not be uploaded yet —
it is identity, not a fetched asset. The site renders `thumbnail` (600px) and
`web` (2048px), both generated locally at upload time. `upload-photos.js` queues
originals to a gitignored `.pending-originals.json`; `upload:originals` drains it.
```

- [ ] **Step 11: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the local-derivative upload flow"
```

---

## Notes for the Implementer

- **Task order matters.** Tasks 1-5 are leaves with no dependencies on each other beyond what the Interfaces blocks state; Tasks 6-9 all depend on them. Do not start Task 6 before Tasks 1-5 are green.
- **`src/data/photos.json` is gitignored** — never commit it, and never commit `.pending-originals.json`.
- **Do not re-run `npm run process --force`.** It would re-derive every photo in the bucket, which is exactly the expensive work this change exists to avoid.
- **If a step's expected output does not match, stop and report it** rather than adjusting the assertion to fit. The Step 5 diff in Task 9 and the Step 5 no-op in Task 8 are regression gates, not formalities.

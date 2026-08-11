# Folder Upload with Already-Uploaded Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `npm run upload <album> <path...>` accept directories as well as files, expand them to the photos inside, and upload only the photos R2 does not already have.

**Architecture:** Two new leaf modules with no knowledge of each other — `scripts/r2list.js` (one paginated, optionally-prefixed bucket listing, replacing two private copies) and `scripts/candidates.js` (pure-ish "what should we upload" logic: path expansion, per-file validation, and the already-uploaded check). `scripts/upload-photos.js` keeps owning "how to upload" and gains a short pipeline that feeds the existing, untouched concurrency/progress/pending-queue loop.

**Tech Stack:** Node 20+ ESM, `node --test` with `node:assert/strict`, `@aws-sdk/client-s3`, `sharp`. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-upload-folder-expansion-design.md`. Read it before Task 1.
- **No new dependencies.** Everything needed is already in `package.json`.
- **The upload loop does not change.** Local resize, sequential thumbnail-then-web send, `createPendingQueue` behaviour, `createProgressDisplay` usage, and `--concurrency` all keep their current semantics. Only what feeds the loop changes.
- **Directory expansion is non-recursive.** Subdirectories inside an expanded directory are ignored.
- **`--force` disables exactly one thing:** the already-uploaded check, which means `listAlbumKeys` is not called at all under `--force`. It does *not* disable validation or expansion.
- **Skip rule:** a photo is already uploaded only when **both** `thumbnailKey(key)` and `webKey(key)` are present in R2.
- **ESM, arrow-function consts, named exports.** Match the surrounding files. Section banners use the existing `// ── name ───…` style padded to 80 columns.
- **Run the whole suite** with `npm test` before each commit, not just the file under test.

## Deviations from the spec

Two, both deliberate; implement as written here.

1. **The spec puts the new functions in `upload-photos.js` and its test file.** They go in a new `scripts/candidates.js` / `scripts/candidates.test.js` pair instead. `upload-photos.js` is already 163 lines of upload mechanics; "which files are candidates" is a separable concern with its own tests and no R2 dependency.
2. **The spec has `partitionCandidates` return `{ files, skipped, errors }` and the caller throw.** It returns `{ files, skipped }` and throws internally, exactly as today's `validateFiles` does — a returned `errors` array that every caller must remember to check is a footgun for a one-caller function.

One in-scope addition the spec does not mention: the private lister is duplicated **four** ways, not the two the spec named — `process.js:19`, `fetch-photos.js:35`, and `r2.js:8` (`listPrefix`, already the prefixed variant this feature needs). Task 1 dedupes all four.

---

## File Structure

**Create:**
- `scripts/r2list.js` — paginated bucket listing. `listAllObjects(client, bucketName, prefix?)`, `listAlbumKeys(client, bucketName, album)`.
- `scripts/r2list.test.js`
- `scripts/candidates.js` — `expandPaths`, `partitionCandidates`, `needsUpload`, `assertNoKeyCollisions`.
- `scripts/candidates.test.js`

**Modify:**
- `scripts/process.js` — delete private `listAllObjects` (lines 19-31), import the shared one.
- `scripts/fetch-photos.js` — delete private `listAllObjects` (lines 35-55), import the shared one.
- `scripts/r2.js` — delete private `listPrefix` (lines 8-21), import the shared one.
- `scripts/upload-photos.js` — `parseArgs` gains `--force` and renames `files` → `paths`; `run()` gains the expansion/filter pipeline; `validateFiles` and `UNDECODABLE_EXTENSIONS` are deleted (they move to `candidates.js`).
- `scripts/upload-photos.test.js` — `--force` cases added, `validateFiles` cases removed (they reappear in `candidates.test.js`).
- `CLAUDE.md` — the `npm run upload` line.

---

### Task 1: Shared prefixed object lister

Four scripts list this bucket and every one of them has its own private copy of the loop — `process.js:19` and `fetch-photos.js:35` unprefixed, `r2.js:8` (`listPrefix`) prefixed. `upload-photos.js` would make a fifth. Extract one lister with an optional prefix.

**Files:**
- Create: `scripts/r2list.js`
- Create: `scripts/r2list.test.js`
- Modify: `scripts/process.js:1-31`, `scripts/process.js:263`
- Modify: `scripts/fetch-photos.js:1`, `scripts/fetch-photos.js:35-55`, `scripts/fetch-photos.js:171`
- Modify: `scripts/r2.js:1-21`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `listAllObjects(client, bucketName, prefix?) => Promise<Array<{Key: string, Size: number, LastModified: Date}>>` — every object, following continuation tokens. Omitting `prefix` lists the whole bucket.
  - `listAlbumKeys(client, bucketName, album) => Promise<Set<string>>` — the key strings under `album/`.

- [ ] **Step 1: Write the failing test**

Create `scripts/r2list.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAllObjects, listAlbumKeys } from './r2list.js';

// Records every command input it is handed, and replays `pages` in order —
// enough to assert both the request shape and the pagination loop.
const stubClient = (pages) => {
  const inputs = [];
  let index = 0;
  return {
    inputs,
    send: async (command) => {
      inputs.push(command.input);
      return pages[index++] ?? {};
    },
  };
};

test('listAllObjects follows continuation tokens and concatenates pages', async () => {
  const client = stubClient([
    { Contents: [{ Key: 'a.jpg' }], NextContinuationToken: 'page2' },
    { Contents: [{ Key: 'b.jpg' }] },
  ]);

  const objects = await listAllObjects(client, 'bucket');

  assert.deepEqual(objects.map(object => object.Key), ['a.jpg', 'b.jpg']);
  assert.equal(client.inputs.length, 2);
  assert.equal(client.inputs[0].ContinuationToken, undefined);
  assert.equal(client.inputs[1].ContinuationToken, 'page2');
});

test('listAllObjects passes the prefix through when given one', async () => {
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket', '2026-italy/');

  assert.equal(client.inputs[0].Prefix, '2026-italy/');
  assert.equal(client.inputs[0].Bucket, 'bucket');
});

test('listAllObjects omits the prefix when none is given', async () => {
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket');

  assert.equal(client.inputs[0].Prefix, undefined);
});

test('listAllObjects treats an empty prefix as no prefix', async () => {
  // `r2 ls` with no argument passes '', and the copy it replaces guarded
  // against sending `Prefix: ''` to S3. Keep that guard.
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket', '');

  assert.equal(client.inputs[0].Prefix, undefined);
});

test('listAllObjects tolerates a page with no Contents', async () => {
  const client = stubClient([{}]);

  assert.deepEqual(await listAllObjects(client, 'bucket'), []);
});

test('listAlbumKeys returns a key set scoped to the album prefix', async () => {
  const client = stubClient([{
    Contents: [
      { Key: '2026-italy/a.jpg' },
      { Key: '2026-italy/.web/a.jpg' },
    ],
  }]);

  const keys = await listAlbumKeys(client, 'bucket', '2026-italy');

  assert.equal(client.inputs[0].Prefix, '2026-italy/');
  assert.ok(keys instanceof Set);
  assert.ok(keys.has('2026-italy/.web/a.jpg'));
  assert.equal(keys.size, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/r2list.test.js`
Expected: FAIL — `Cannot find module '.../scripts/r2list.js'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/r2list.js`:

```js
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

// One paginated sweep of the bucket. `prefix` is optional: omit it to list
// everything (fetch-photos, process), pass `album/` to list one album. An
// empty string is normalised to `undefined` — `r2 ls` with no argument passes
// one, and S3 should see no Prefix at all rather than an empty one.
export const listAllObjects = async (client, bucketName, prefix) => {
  const objects = [];
  let continuationToken;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }));

    if (response.Contents) objects.push(...response.Contents);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
};

export const listAlbumKeys = async (client, bucketName, album) =>
  new Set((await listAllObjects(client, bucketName, `${album}/`)).map(object => object.Key));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/r2list.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Rewire `process.js` onto the shared lister**

In `scripts/process.js`, delete the private `listAllObjects` (lines 19-31) and drop `ListObjectsV2Command` from the SDK import, which no longer uses it:

```js
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
```

Add to the import block, after the `r2client.js` import:

```js
import { listAllObjects } from './r2list.js';
```

The call site at line 263 (`const objects = await listAllObjects(client, bucketName);`) is unchanged — the new signature's third parameter is optional.

- [ ] **Step 6: Rewire `fetch-photos.js` onto the shared lister**

In `scripts/fetch-photos.js`, delete the private `listAllObjects` (lines 35-55) and drop `ListObjectsV2Command` from the SDK import:

```js
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
```

Add after the `keys.js` import:

```js
import { listAllObjects } from './r2list.js';
```

The call site at line 171 is unchanged.

- [ ] **Step 7: Rewire `r2.js` onto the shared lister**

In `scripts/r2.js`, delete the private `listPrefix` (lines 8-21) along with the now-empty `// ── helpers ──` banner, and drop `ListObjectsV2Command` from the SDK import:

```js
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
```

Add after the `format.js` import:

```js
import { listAllObjects } from './r2list.js';
```

Then rename the two call sites. `listPrefix(client, bucketName, prefix)` becomes `listAllObjects(client, bucketName, prefix)` — same argument order, and the `prefix || undefined` guard now lives inside the shared function. Find them with:

```bash
grep -n "listPrefix" scripts/r2.js
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — every existing test still green. All three rewired files are import-only changes; a failure here means an import was missed.

- [ ] **Step 9: Verify the rewired scripts still talk to R2**

```bash
npm run build:photos
git diff --stat src/data/photos.json
```
Expected: `build:photos` succeeds and the diff is empty, or shows only `LastModified`-driven churn. A changed album or photo count means the listing broke.

```bash
node scripts/r2.js ls
node scripts/r2.js ls 2026-italy/
```
Expected: the first lists the whole bucket (the empty-prefix path), the second only that album. Substitute any album that exists in your bucket.

- [ ] **Step 10: Commit**

```bash
git add scripts/r2list.js scripts/r2list.test.js scripts/process.js scripts/fetch-photos.js scripts/r2.js
git commit -m "Extract one prefixed R2 lister from four private copies"
```

---

### Task 2: `expandPaths` — a path is a file or a directory

**Files:**
- Create: `scripts/candidates.js`
- Create: `scripts/candidates.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `expandPaths(paths: string[]) => Array<{filePath: string, explicit: boolean}>`. `explicit: true` means the user named this path on the command line; `explicit: false` means the script found it inside a directory. Task 3 branches on that flag.

- [ ] **Step 1: Write the failing test**

Create `scripts/candidates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expandPaths } from './candidates.js';

// Real files on disk: expandPaths asks the filesystem what a path is, and
// partitionCandidates (Task 3) asks whether it exists. Stubbing fs would test
// the stub instead of the behaviour.
const fixture = ({ dirs = [], files = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'candidates-'));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) writeFileSync(join(root, file), '');
  return root;
};

test('expandPaths keeps a plain file as an explicit entry', () => {
  const root = fixture({ files: ['a.jpg'] });

  assert.deepEqual(expandPaths([join(root, 'a.jpg')]), [
    { filePath: join(root, 'a.jpg'), explicit: true },
  ]);
});

test('expandPaths expands a directory into its files, sorted, non-explicit', () => {
  const root = fixture({ files: ['b.jpg', 'a.jpg'] });

  assert.deepEqual(expandPaths([root]), [
    { filePath: join(root, 'a.jpg'), explicit: false },
    { filePath: join(root, 'b.jpg'), explicit: false },
  ]);
});

test('expandPaths does not descend into subdirectories', () => {
  const root = fixture({ dirs: ['nested'], files: ['a.jpg', join('nested', 'b.jpg')] });

  assert.deepEqual(expandPaths([root]).map(entry => entry.filePath), [join(root, 'a.jpg')]);
});

test('expandPaths drops hidden files found inside a directory', () => {
  const root = fixture({ files: ['a.jpg', '.DS_Store', '._a.jpg'] });

  // `._a.jpg` is the dangerous one: an AppleDouble sidecar carries a real
  // image extension and would upload as a corrupt photo.
  assert.deepEqual(expandPaths([root]).map(entry => entry.filePath), [join(root, 'a.jpg')]);
});

test('expandPaths leaves a nonexistent path as an explicit entry', () => {
  // Not an error here — it flows through so partitionCandidates reports
  // "File not found" rather than a raw fs throw escaping.
  assert.deepEqual(expandPaths(['/nope/missing.jpg']), [
    { filePath: '/nope/missing.jpg', explicit: true },
  ]);
});

test('expandPaths handles a mixed list of files and directories', () => {
  const root = fixture({ dirs: ['album'], files: ['loose.jpg', join('album', 'a.jpg')] });

  assert.deepEqual(expandPaths([join(root, 'album'), join(root, 'loose.jpg')]), [
    { filePath: join(root, 'album', 'a.jpg'), explicit: false },
    { filePath: join(root, 'loose.jpg'), explicit: true },
  ]);
});

test('expandPaths contributes nothing for an empty directory', () => {
  assert.deepEqual(expandPaths([fixture({})]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/candidates.test.js`
Expected: FAIL — `Cannot find module '.../scripts/candidates.js'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/candidates.js`:

```js
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

// ── path expansion ────────────────────────────────────────────────────────────

// A missing path is deliberately not an error here. It flows through as an
// explicit entry so partitionCandidates reports "File not found" with the rest
// of the validation, instead of a raw fs error escaping mid-expansion.
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const readDirectory = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory ${path}: ${error.message}`);
  }
};

// Tags each candidate with whether the user *named* it or the script *found*
// it inside a directory — the distinction partitionCandidates branches on.
// Hidden entries are dropped: `.DS_Store` is noise, but an AppleDouble
// `._IMG_0001.jpg` sidecar carries a real image extension and would otherwise
// upload as a corrupt photo.
export const expandPaths = (paths) => paths.flatMap((path) => {
  if (!isDirectory(path)) return [{ filePath: path, explicit: true }];

  return readDirectory(path)
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => ({ filePath: join(path, entry.name), explicit: false }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/candidates.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/candidates.js scripts/candidates.test.js
git commit -m "Expand a directory argument into the photos inside it"
```

---

### Task 3: `partitionCandidates` — named files error, found files are filtered

A file the user named is a file the user wants, so a problem with it is an error. A file the script found inside a directory is just something that was in the folder, so a problem with it is not the user's mistake. This is what lets you point at a real export folder full of `.xmp` sidecars and RAW files.

`validateFiles` in `upload-photos.js` stays in place for now — Task 7 deletes it once `run()` is rewired. A brief duplicate is the cost of keeping both tasks independently testable.

**Files:**
- Modify: `scripts/candidates.js`
- Modify: `scripts/candidates.test.js`

**Interfaces:**
- Consumes: `expandPaths` (Task 2) — its entry shape `{filePath, explicit}` is this function's input.
- Produces: `partitionCandidates(entries) => {files: string[], skipped: string[]}`. `files` are paths to upload; `skipped` are human-readable notes the caller prints. Throws `Error` with newline-joined messages if any *explicit* entry has a problem.

- [ ] **Step 1: Write the failing test**

Append to `scripts/candidates.test.js`, and extend the existing import at the top of the file to `import { expandPaths, partitionCandidates } from './candidates.js';`:

```js
// ── partitionCandidates ───────────────────────────────────────────────────────

const named = (filePath) => ({ filePath, explicit: true });
const found = (filePath) => ({ filePath, explicit: false });

test('partitionCandidates accepts a supported image either way', () => {
  const root = fixture({ files: ['a.jpg', 'b.png'] });
  const { files, skipped } = partitionCandidates([
    named(join(root, 'a.jpg')),
    found(join(root, 'b.png')),
  ]);

  assert.deepEqual(files, [join(root, 'a.jpg'), join(root, 'b.png')]);
  assert.deepEqual(skipped, []);
});

test('partitionCandidates throws for a named file that is missing', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/missing.jpg')]),
    /File not found: \/nope\/missing\.jpg/,
  );
});

test('partitionCandidates throws for a named heic with an actionable message', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/photo.heic')]),
    /cannot be resized locally.*[Cc]onvert/s,
  );
});

test('partitionCandidates throws for a named unsupported extension', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/notes.txt')]),
    /Unsupported file type/,
  );
});

test('partitionCandidates joins every named-file error into one message', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/a.txt'), named('/nope/b.txt')]),
    /a\.txt[\s\S]*b\.txt/,
  );
});

test('partitionCandidates reports a found heic as skipped instead of failing', () => {
  const root = fixture({ files: ['a.jpg'] });
  const { files, skipped } = partitionCandidates([
    found(join(root, 'a.jpg')),
    found(join(root, 'shot.heic')),
  ]);

  // One HEIC in the folder must not block the other 200 photos.
  assert.deepEqual(files, [join(root, 'a.jpg')]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /shot\.heic.*cannot be resized locally/s);
});

test('partitionCandidates drops other found non-images silently', () => {
  const root = fixture({ files: ['a.jpg'] });
  const { files, skipped } = partitionCandidates([
    found(join(root, 'a.jpg')),
    found(join(root, 'a.xmp')),
    found(join(root, 'a.cr2')),
  ]);

  assert.deepEqual(files, [join(root, 'a.jpg')]);
  assert.deepEqual(skipped, []);
});

test('partitionCandidates handles a whole real folder end to end', () => {
  const root = fixture({ files: ['a.jpg', 'b.jpeg', 'notes.txt', '.DS_Store'] });
  const { files, skipped } = partitionCandidates(expandPaths([root]));

  assert.deepEqual(files, [join(root, 'a.jpg'), join(root, 'b.jpeg')]);
  assert.deepEqual(skipped, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/candidates.test.js`
Expected: FAIL — `The requested module './candidates.js' does not provide an export named 'partitionCandidates'`

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/candidates.js`, and extend its fs/path imports to `import { existsSync, readdirSync, statSync } from 'fs';` and `import { extname, join } from 'path';`:

```js
// ── validation ────────────────────────────────────────────────────────────────

const UNDECODABLE_EXTENSIONS = new Set(['.heic', '.heif']);

// Checked in this order so the HEIC hint wins over the generic
// "unsupported type" message for a file that is genuinely a photo.
const problemWith = (filePath) => {
  const ext = extname(filePath).toLowerCase();

  if (UNDECODABLE_EXTENSIONS.has(ext)) {
    return `${filePath} cannot be resized locally (${ext} decoding is unavailable). ` +
           `Convert it to JPEG first, e.g. \`sips -s format jpeg "${filePath}" --out "${filePath.replace(/\.[^.]+$/, '.jpg')}"\`.`;
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) return `Unsupported file type: ${filePath} (${ext})`;
  if (!existsSync(filePath)) return `File not found: ${filePath}`;
  return null;
};

// A file the user named is a file the user wants: a problem with it is an
// error. A file found inside a directory is just something that was in the
// folder, so `.xmp` sidecars and RAW files drop out silently. HEIC is the one
// exception — it *is* a photo they probably want, so it is reported rather
// than dropped, but it must not fail the batch the way naming it would.
export const partitionCandidates = (entries) => {
  const files = [];
  const skipped = [];
  const errors = [];

  for (const { filePath, explicit } of entries) {
    const problem = problemWith(filePath);

    if (!problem) files.push(filePath);
    else if (explicit) errors.push(problem);
    else if (UNDECODABLE_EXTENSIONS.has(extname(filePath).toLowerCase())) skipped.push(problem);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { files, skipped };
};
```

Add the `SUPPORTED_EXTENSIONS` import at the top of the file, below the fs/path imports:

```js
import { SUPPORTED_EXTENSIONS } from './upload.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/candidates.test.js`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/candidates.js scripts/candidates.test.js
git commit -m "Validate named files strictly and found files leniently"
```

---

### Task 4: `needsUpload` — the already-uploaded check

**Files:**
- Modify: `scripts/candidates.js`
- Modify: `scripts/candidates.test.js`

**Interfaces:**
- Consumes: `thumbnailKey` and `webKey` from `scripts/keys.js` (existing, unchanged).
- Produces: `needsUpload(presentKeys: Set<string>, key: string) => boolean`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/candidates.test.js`, extending the import to `import { expandPaths, partitionCandidates, needsUpload } from './candidates.js';`:

```js
// ── needsUpload ───────────────────────────────────────────────────────────────

const KEY = '2026-italy/a.jpg';
const THUMBNAIL = '2026-italy/.thumbnails/a.jpg';
const WEB = '2026-italy/.web/a.jpg';

test('needsUpload is false when both derivatives are present', () => {
  assert.equal(needsUpload(new Set([THUMBNAIL, WEB]), KEY), false);
});

test('needsUpload is true when only the thumbnail is present', () => {
  // A run that died between the two sends is redone, not left half-published.
  assert.equal(needsUpload(new Set([THUMBNAIL]), KEY), true);
});

test('needsUpload is true when only the web derivative is present', () => {
  assert.equal(needsUpload(new Set([WEB]), KEY), true);
});

test('needsUpload is true when neither derivative is present', () => {
  assert.equal(needsUpload(new Set(), KEY), true);
});

test('needsUpload ignores the original — derivatives are what the site serves', () => {
  assert.equal(needsUpload(new Set([KEY]), KEY), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/candidates.test.js`
Expected: FAIL — `The requested module './candidates.js' does not provide an export named 'needsUpload'`

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/candidates.js`, adding the import below the `upload.js` import:

```js
import { thumbnailKey, webKey } from './keys.js';
```

```js
// ── already-uploaded check ────────────────────────────────────────────────────

// Both derivatives, not just `.web/`. `logicalPhotoKeys` treats a web copy
// alone as proof a photo exists, which is right for *display* — but an upload
// that died between the thumbnail send and the web send should be redone, so
// the bar for skipping work is higher than the bar for showing a photo.
export const needsUpload = (presentKeys, key) =>
  !presentKeys.has(thumbnailKey(key)) || !presentKeys.has(webKey(key));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/candidates.test.js`
Expected: PASS — 20 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/candidates.js scripts/candidates.test.js
git commit -m "Skip photos that already have both derivatives in R2"
```

---

### Task 5: `assertNoKeyCollisions` — two local files, one R2 key

`album/IMG_0001.jpg` is derived from a file's basename, so `~/Trip/day1/IMG_0001.jpg` and `~/Trip/day2/IMG_0001.jpg` both claim it and the second silently overwrites the first. Passing two directories makes that easy to hit by accident, and the already-uploaded check compounds it: after the overwrite, a re-run reports both photos as "already uploaded". Fail before any bytes move.

**Files:**
- Modify: `scripts/candidates.js`
- Modify: `scripts/candidates.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks — it takes the `{filePath, key}` candidate objects that Task 7's `run()` builds.
- Produces: `assertNoKeyCollisions(candidates: Array<{filePath: string, key: string}>) => void`. Throws `Error` naming every colliding group; returns nothing on success.

- [ ] **Step 1: Write the failing test**

Append to `scripts/candidates.test.js`, extending the import to `import { expandPaths, partitionCandidates, needsUpload, assertNoKeyCollisions } from './candidates.js';`:

```js
// ── assertNoKeyCollisions ─────────────────────────────────────────────────────

const candidate = (filePath, key) => ({ filePath, key });

test('assertNoKeyCollisions passes when every key is distinct', () => {
  assert.doesNotThrow(() => assertNoKeyCollisions([
    candidate('/trip/day1/a.jpg', 'trip/a.jpg'),
    candidate('/trip/day2/b.jpg', 'trip/b.jpg'),
  ]));
});

test('assertNoKeyCollisions throws naming both colliding files', () => {
  assert.throws(
    () => assertNoKeyCollisions([
      candidate('/trip/day1/IMG_0001.jpg', 'trip/IMG_0001.jpg'),
      candidate('/trip/day2/IMG_0001.jpg', 'trip/IMG_0001.jpg'),
    ]),
    /trip\/IMG_0001\.jpg[\s\S]*day1[\s\S]*day2/,
  );
});

test('assertNoKeyCollisions reports every colliding group at once', () => {
  assert.throws(
    () => assertNoKeyCollisions([
      candidate('/a/one.jpg', 'trip/one.jpg'),
      candidate('/b/one.jpg', 'trip/one.jpg'),
      candidate('/a/two.jpg', 'trip/two.jpg'),
      candidate('/b/two.jpg', 'trip/two.jpg'),
    ]),
    /one\.jpg[\s\S]*two\.jpg/,
  );
});

test('assertNoKeyCollisions accepts the same file listed twice', () => {
  // `upload album dir dir/a.jpg` names one file two ways. Same bytes, same
  // destination — nothing is lost, so it is not a collision.
  assert.doesNotThrow(() => assertNoKeyCollisions([
    candidate('/trip/a.jpg', 'trip/a.jpg'),
    candidate('/trip/a.jpg', 'trip/a.jpg'),
  ]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/candidates.test.js`
Expected: FAIL — `The requested module './candidates.js' does not provide an export named 'assertNoKeyCollisions'`

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/candidates.js`:

```js
// ── collisions ────────────────────────────────────────────────────────────────

// The R2 key comes from the basename, so two directories holding the same
// filename both claim one key and the second upload silently destroys the
// first. Worse, the next run then sees the key as present and reports both
// photos as already uploaded. Refuse the whole batch instead.
export const assertNoKeyCollisions = (candidates) => {
  const pathsByKey = new Map();
  for (const { filePath, key } of candidates) {
    const paths = pathsByKey.get(key) ?? new Set();
    paths.add(filePath);
    pathsByKey.set(key, paths);
  }

  const collisions = [...pathsByKey]
    .filter(([, paths]) => paths.size > 1)
    .map(([key, paths]) => `  ${key} ← ${[...paths].join(', ')}`);

  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} filename collision(s) — these would overwrite each other in R2:\n` +
      `${collisions.join('\n')}\n` +
      'Rename the files or upload the folders to separate albums.'
    );
  }
};
```

A `Set` per key, not a count: the same path listed twice is one photo named two ways, not a collision.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/candidates.test.js`
Expected: PASS — 24 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/candidates.js scripts/candidates.test.js
git commit -m "Refuse a batch where two local files claim one R2 key"
```

---

### Task 6: `parseArgs` learns `--force` and speaks in paths

**Files:**
- Modify: `scripts/upload-photos.js:18-28`, `scripts/upload-photos.js:93-109`
- Modify: `scripts/upload-photos.test.js:5-28`

**Interfaces:**
- Consumes: `parseConcurrencyFlag` from `scripts/concurrency.js` (existing, unchanged).
- Produces: `parseArgs(args: string[]) => {folder: string, paths: string[], concurrency: number, force: boolean}`. Note `paths`, not `files` — Task 7 relies on that name.

- [ ] **Step 1: Write the failing test**

In `scripts/upload-photos.test.js`, replace the `parseArgs` section (lines 5-28) with:

```js
// ── parseArgs ─────────────────────────────────────────────────────────────────

test('parseArgs splits the album from the paths', () => {
  assert.deepEqual(parseArgs(['iceland-2026', 'a.jpg', 'b.jpg']), {
    folder: 'iceland-2026',
    paths: ['a.jpg', 'b.jpg'],
    concurrency: 6,
    force: false,
  });
});

test('parseArgs accepts a single directory path', () => {
  assert.deepEqual(parseArgs(['iceland-2026', '~/Pictures/Export']).paths, ['~/Pictures/Export']);
});

test('parseArgs honours --concurrency in any position', () => {
  assert.equal(parseArgs(['--concurrency', '3', 'album', 'a.jpg']).concurrency, 3);
  assert.equal(parseArgs(['album', '--concurrency', '3', 'a.jpg']).concurrency, 3);
  assert.deepEqual(parseArgs(['album', '--concurrency', '3', 'a.jpg']).paths, ['a.jpg']);
});

test('parseArgs honours --force in any position without consuming a path', () => {
  assert.equal(parseArgs(['--force', 'album', 'a.jpg']).force, true);
  assert.equal(parseArgs(['album', '--force', 'a.jpg']).force, true);
  assert.deepEqual(parseArgs(['album', '--force', 'a.jpg']).paths, ['a.jpg']);
});

test('parseArgs combines --force and --concurrency', () => {
  const parsed = parseArgs(['--force', '--concurrency', '2', 'album', 'dir']);

  assert.equal(parsed.force, true);
  assert.equal(parsed.concurrency, 2);
  assert.deepEqual(parsed.paths, ['dir']);
});

test('parseArgs rejects a missing album or path list', () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['album']), /Usage:/);
  assert.throws(() => parseArgs(['--force', 'album']), /Usage:/);
});

test('parseArgs rejects an invalid concurrency', () => {
  assert.throws(() => parseArgs(['--concurrency', '0', 'album', 'a.jpg']), /positive integer/);
});
```

Also change the import on line 3 to drop `validateFiles`, whose tests move to `candidates.test.js` in this step:

```js
import { parseArgs } from './upload-photos.js';
```

And delete the entire `validateFiles` section (lines 30-46) — Task 3 already covers those three cases as the `explicit: true` rows of `partitionCandidates`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/upload-photos.test.js`
Expected: FAIL — the first test fails on the returned object having `files` and no `force` key.

- [ ] **Step 3: Write minimal implementation**

In `scripts/upload-photos.js`, replace the `USAGE` constant (line 18) and `parseArgs` (lines 22-28):

```js
const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] [--force] <album> <path1> [path2 ...]';
```

```js
export const parseArgs = (args) => {
  const force = args.includes('--force');
  const { concurrency, rest } = parseConcurrencyFlag(args.filter(arg => arg !== '--force'));
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...paths] = rest;
  return { folder, paths, concurrency: concurrency ?? DEFAULT_CONCURRENCY, force };
};
```

`--force` is stripped before `parseConcurrencyFlag` so it cannot be mistaken for the flag's value, matching how `process.js:253-254` handles the same pair.

In `run()`, update only the destructuring and the two lines that referenced `files`, so the script keeps working until Task 7 rewires it properly:

```js
  const { folder, paths, concurrency } = parseArgs(process.argv.slice(2));
  validateFiles(paths);
```

```js
  const items = paths.map(filePath => ({
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the whole suite, including the 20 `candidates.test.js` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/upload-photos.js scripts/upload-photos.test.js
git commit -m "Add --force and rename the file list to paths"
```

---

### Task 7: Wire the pipeline into `run()`

The final task: `run()` expands paths, filters against R2, reports what it skipped, and hands the remainder to the existing upload loop unchanged.

**Files:**
- Modify: `scripts/upload-photos.js` — delete `UNDECODABLE_EXTENSIONS` (line 14) and `validateFiles` (lines 30-44), add imports, rewrite `run()` (lines 93-153).
- Modify: `CLAUDE.md:6`

**Interfaces:**
- Consumes: `listAlbumKeys` (Task 1), `expandPaths` / `partitionCandidates` / `needsUpload` / `assertNoKeyCollisions` (Tasks 2-5), `parseArgs` returning `{folder, paths, concurrency, force}` (Task 6).
- Produces: nothing — this is the entry point.

- [ ] **Step 1: Replace the imports and delete the moved code**

In `scripts/upload-photos.js`, add two imports after the `pendingOriginals.js` import:

```js
import { listAlbumKeys } from './r2list.js';
import {
  expandPaths,
  partitionCandidates,
  needsUpload,
  assertNoKeyCollisions,
} from './candidates.js';
```

Then delete, in this order:
- `UNDECODABLE_EXTENSIONS` (line 14) — now lives in `candidates.js`.
- The whole `export const validateFiles = ...` block (lines 30-44), leaving the `// ── argument handling ──` section holding only `parseArgs`.

That orphans three imports, all of which existed only for `validateFiles`. Line 2 (`import { existsSync } from 'fs';`) goes away entirely — keep line 1's `import { readFile } from 'fs/promises';`, which `uploadPhoto` still uses. The other two shed a name each:

```js
import { basename, resolve } from 'path';
import { uploadToR2 } from './upload.js';
```

- [ ] **Step 2: Add the selection helper**

Add above `// ── main ──` in `scripts/upload-photos.js`:

```js
// ── selection ─────────────────────────────────────────────────────────────────

// Which candidates R2 does not already have. `--force` skips the listing
// entirely rather than listing and ignoring the result — the filter is the
// listing's only consumer.
const selectPending = async (client, bucketName, folder, candidates, force) => {
  if (force) {
    console.log(`--force: uploading all ${candidates.length} photo(s)`);
    return candidates;
  }

  const presentKeys = await listAlbumKeys(client, bucketName, folder);
  const pending = candidates.filter(candidate => needsUpload(presentKeys, candidate.key));

  console.log(`${candidates.length - pending.length} already uploaded — skipping.`);
  return pending;
};
```

- [ ] **Step 3: Rewrite `run()`**

Replace `run()` in `scripts/upload-photos.js` with:

```js
const run = async () => {
  const { folder, paths, concurrency, force } = parseArgs(process.argv.slice(2));

  const { files, skipped } = partitionCandidates(expandPaths(paths));
  for (const note of skipped) console.warn(`Skipped: ${note}`);

  const candidates = files.map(filePath => ({
    filePath,
    key: `${folder}/${basename(filePath)}`,
  }));
  // Before any network work: two files claiming one key would overwrite each
  // other, and the second run would then call both of them already uploaded.
  assertNoKeyCollisions(candidates);
  console.log(`${candidates.length} photo(s) found.`);

  if (candidates.length === 0) {
    console.log('Nothing to upload.');
    return;
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  const pending = await selectPending(client, bucketName, folder, candidates, force);
  if (pending.length === 0) {
    console.log('Nothing to upload.');
    return;
  }

  const queue = createPendingQueue();

  const items = pending.map(candidate => ({
    id: candidate.filePath,
    filePath: candidate.filePath,
    name: basename(candidate.filePath),
    key: candidate.key,
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
```

The upload loop from `const display = ...` down is byte-identical to what is there today; only what builds `items` above it changed.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — everything green. `upload-photos.js` no longer exports `validateFiles`, and no test imports it.

- [ ] **Step 5: Verify against a real R2 album**

These hit the network. Use the throwaway `zz-scratch` album so nothing real is touched.

Build a fixture folder holding three real photos plus the debris that lives in every export folder. Substitute any directory of your own JPEGs for the source:

```bash
rm -rf /tmp/upload-check && mkdir -p /tmp/upload-check
find ~/Photograph -iname '*.jpg' -type f | head -3 | xargs -I{} cp {} /tmp/upload-check/
touch /tmp/upload-check/notes.xmp /tmp/upload-check/.DS_Store
ls -a /tmp/upload-check    # expect: 3 jpgs, notes.xmp, .DS_Store
```

Run each and confirm the stated expectation:

```bash
node scripts/upload-photos.js zz-scratch /tmp/upload-check
```
Expected: `3 photo(s) found.` / `0 already uploaded — skipping.` / progress bars / `3/3 uploaded to zz-scratch/`. The `.xmp` and `.DS_Store` are never mentioned.

```bash
node scripts/upload-photos.js zz-scratch /tmp/upload-check
```
Expected: `3 photo(s) found.` / `3 already uploaded — skipping.` / `Nothing to upload.` — no network upload, exit 0. **This is the feature.**

```bash
node scripts/upload-photos.js --force zz-scratch /tmp/upload-check
```
Expected: `--force: uploading all 3 photo(s)` and all three re-upload.

```bash
node scripts/upload-photos.js zz-scratch /tmp/upload-check/does-not-exist.jpg
```
Expected: `Error: File not found: /tmp/upload-check/does-not-exist.jpg`, exit 1.

```bash
mkdir -p /tmp/upload-check-2
cp /tmp/upload-check/*.jpg /tmp/upload-check-2/
node scripts/upload-photos.js zz-scratch /tmp/upload-check /tmp/upload-check-2
```
Expected: `Error: 3 filename collision(s)` listing each key and both source paths, exit 1, nothing uploaded. Then `rm -rf /tmp/upload-check-2`.

Then clean up. `r2 rm` takes one key at a time; `r2 ls` prints `date size key`, so take the last field of the lines that name a key:

```bash
node scripts/r2.js ls zz-scratch/ | grep 'zz-scratch/' | awk '{print $NF}' \
  | xargs -n1 node scripts/r2.js rm
node scripts/r2.js ls zz-scratch/    # expect: (no objects found)
```

The uploads also queued three originals locally. `r2 rm` warns about them but does not remove them, so drop them by hand — `.pending-originals.json` is gitignored local state and editing it is fine:

```bash
grep -c zz-scratch .pending-originals.json   # then delete those entries
```

- [ ] **Step 6: Update `CLAUDE.md`**

Replace the `npm run upload` line (line 6) in the Commands block:

```
npm run upload           # <album> <paths...> — files or folders; skips photos already in R2 (--force to re-upload)
```

- [ ] **Step 7: Commit**

```bash
git add scripts/upload-photos.js CLAUDE.md
git commit -m "Upload a folder, skipping photos already in R2"
```

---

## Verification Checklist

- [ ] `npm test` passes.
- [ ] `npm run build:photos` produces the same `photos.json` as before Task 1.
- [ ] Pointing at a folder twice uploads on the first run and skips on the second.
- [ ] `--force` re-uploads a fully-uploaded folder.
- [ ] A `.xmp`/`.DS_Store`/RAW file in the folder is ignored silently; a `.heic` is reported and skipped without failing.
- [ ] Naming a missing or unsupported file directly still errors and exits 1.
- [ ] Two folders holding the same filename error before anything uploads.
- [ ] `grep -rn "ListObjectsV2Command" scripts/` shows one occurrence, in `r2list.js`.
- [ ] `grep -rn "validateFiles\|listPrefix" scripts/` returns nothing.

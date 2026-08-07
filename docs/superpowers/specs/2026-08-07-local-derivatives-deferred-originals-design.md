# Local Derivatives with Deferred Originals

**Date:** 2026-08-07
**Status:** Approved design

## Goal

Uploading a shoot from remote wifi is dominated by bytes nobody ever loads.
`scripts/upload-photos.js` pushes the full-size original of every photo, then
`scripts/process.js` downloads each one back out of R2, resizes it to 2048px
(`.web/`) and 600px (`.thumbnails/`), and uploads those. The site never displays
the original: `PhotoGrid.jsx:39` renders `thumbnail`, `PhotoViewer.jsx:185`
renders `web`. A ~12MB camera JPEG is therefore carried over the slow link to
produce ~500KB + ~60KB of actually-served image.

Move the resize to the machine holding the photos:

1. **`upload-photos.js` generates both derivatives locally** and uploads only
   those — roughly a 20x cut in bytes over the slow link.
2. **Originals are queued to a local manifest** and pushed later by a separate
   command run on fast wifi. Nothing is lost; it is deferred.

Deferring the original breaks the assumption the rest of the pipeline is built
on — that a photo *is* an original object in the bucket — so discovery inverts to
key off `.web/`, and EXIF learns to read from the web derivative.

## Non-Goals

- **No change to what the site serves.** `photos.json` keeps the same shape and
  the same three URLs per photo.
- **No new image sizes or formats.** Still 600px/q80 and 2048px/q85 JPEG, and
  derivatives still keep the source filename's extension (`photo.png` →
  `.web/photo.png` holding JPEG bytes), exactly as `process.js:60` does today.
  Changing that would orphan every derivative already in the bucket.
- **No re-derivation of existing photos.** Everything already in R2 keeps its
  current derivatives untouched.
- **No parallel upload/queue coordination across machines.** The manifest is
  local state for one laptop.

## Architecture

```
upload-photos.js ──→ sharp (local)  ──→ .thumbnails/ + .web/   [slow link, small]
                 └─→ pendingOriginals.js ──→ .pending-originals.json

upload-originals.js ──→ manifest ──→ originals                 [fast link, large]

process.js       ──→ backfill only: originals in R2 missing derivatives
fetch-photos.js  ──→ photo list from originals ∪ implied-by-.web/
```

### `scripts/upload-photos.js` (rewritten upload path)

Argument parsing, validation, concurrency, and the progress display are
unchanged. The per-file worker becomes derive-then-upload:

1. `sharp(filePath)` produces the thumbnail (600px, q80) and the web image
   (2048px, q85, **`keepMetadata()`**), reusing the `resizeTo` shape from
   `process.js:179`.
2. Both buffers upload to `album/.thumbnails/name.jpg` and `album/.web/name.jpg`.
3. `{ localPath, key }` is appended to the pending-originals manifest, where
   `key` is the original's logical key (`album/name.jpg`).

`keepMetadata()` is load-bearing. sharp strips EXIF by default, and once the
original is absent the web derivative is the only EXIF source. Existing `.web/`
objects were written without it and carry no EXIF — that is fine, because every
one of them is already in `exif-cache.json` and will never be re-read.

The manifest append happens **after** both derivative uploads succeed. A photo
whose derivatives failed is a photo to re-run, not one to queue.

Concurrency default stays at 6. sharp decodes run inside the same workers; the
libvips threadpool handles the overlap, and adding a second knob for it is
unjustified until it demonstrably matters.

`resizeTo` moves into a shared `scripts/derivatives.js` so `upload-photos.js` and
`process.js` share one definition of what a thumbnail and a web image are. Two
copies of those constants drifting apart would silently produce mismatched
derivatives depending on which path created them.

### `scripts/progress.js` (one change)

Derivative sizes are not known until the resize completes, but `bytesTotal` is
captured once at construction (`progress.js:88`). Leaving it as the original file
size would overstate the denominator by ~20x and make the ETA meaningless.

`bytesTotal` moves into `snapshot()`, summing each task's current `total`
alongside the `bytesDone` sum already computed there. A new
`setTaskTotal(id, bytes)` sets it once the buffers exist.

`upload-photos.js` accordingly builds its items with `totalBytes: null` and drops
the `statSync` at line 84 — the original's size on disk is no longer a quantity
this script uploads.

Until then the task carries `total: null`, which `renderTaskDetail`
(`progress.js:31`) already renders as the `—` bar with its note — the same
count-mode path the EXIF phase uses. The task shows `resizing`, then gains a real
bar. The aggregate total firms up over the first few seconds rather than lying.

`renderDisplay` and `renderBar` are untouched, so `progress.test.js` stays valid;
the new behaviour is covered by extending the `createProgressDisplay` cases.

### `scripts/pendingOriginals.js` (new)

Pure queue operations over an array, plus a thin fs shell — so the logic is
testable without touching disk, following how `favorites.js` and
`lensOverrides.js` are structured.

```js
// pure
export const addPending = (entries, entry) => /* Array, deduped by key */;
export const removePending = (entries, key) => /* Array */;
export const parsePending = (text) => /* Array, [] on malformed */;

// shell — read/write injected, so the queue is testable without touching disk
export const createPendingQueue = ({ read, write }) => ({
  load: () => /* Array */,
  add: (entry) => /* Promise<Array> */,
  remove: (key) => /* Promise<Array> */,
});
```

`addPending` dedupes by `key`: re-uploading the same photo replaces its entry
rather than queueing the original twice.

Writes are chained through a single promise, the way `process.js:127-131` chains
the EXIF cache saves. Every concurrent upload worker appends to the same file,
and two overlapping read-modify-writes would drop entries.

Manifest location is `.pending-originals.json` at repo root, added to
`.gitignore` alongside the other generated data. It is machine-local state, not
something to sync.

### `scripts/upload-originals.js` (new)

`npm run upload:originals`, no arguments.

Reads the manifest and uploads each original using today's `uploadFile` from
`upload-photos.js:52` essentially verbatim — the `Upload` built inside the
retried closure, `httpUploadProgress` into the display, the same
`mapWithConcurrency` pool. That function moves to a shared `scripts/upload.js`,
matching how `retry.js` and `concurrency.js` each own one operation, and both
upload scripts import it.

The comment at `upload-photos.js:49` — that the `Upload` must be built inside the
retried closure because a consumed read stream cannot be replayed — belongs
**here**, with the originals. This script is the one still streaming from disk.
`upload-photos.js` now passes in-memory derivative buffers, which are replayable,
so the constraint no longer binds there.

Each entry is removed from the manifest as its upload succeeds, so an
interrupted run resumes where it stopped rather than restarting. Entries whose
`localPath` no longer exists are reported and dropped — the photo was moved or
deleted, and re-queueing it forever helps nobody.

An empty or missing manifest prints "nothing pending" and exits 0.

Accepts `--concurrency N`, defaulting to 6, matching `upload-photos.js`.

### `scripts/keys.js` (extended)

Adds the inverse of the two existing helpers:

```js
export const originalKey = (key) => /* 'a/.web/p.jpg' | 'a/.thumbnails/p.jpg' → 'a/p.jpg' */;
export const logicalPhotoKeys = (keys) => /* Set of original keys */;
```

`logicalPhotoKeys` is the discovery inversion: the union of original keys present
in the bucket and the originals *implied* by `.web/` keys. It is pure — it takes
an array of object keys and returns a Set — so it is directly testable.

`process.js:29-36` currently defines its own `derivedKey`/`thumbnailKey`/`webKey`,
duplicating `keys.js` exactly. Those go; `process.js` imports them.

### `scripts/fetch-photos.js` (modified)

`parseObjects` (line 82) iterates raw bucket objects and skips dot-prefixed
filenames, which means an album whose original is not yet uploaded appears empty.
It instead iterates `logicalPhotoKeys(objects)`.

`photo.url` keeps pointing at the original's URL even before that object exists.
Nothing fetches it — `PhotoGrid.jsx:10,35` use it only as React key and
deleted-check identity, and `favorites.json`, `album-covers.json`, and
`lens-overrides.json` are all keyed off that same original key. Repointing it at
`.web/` would orphan all three.

`thumbnail` and `web` already fall back to the original when the derivative is
missing (lines 115-123); with derivatives now uploaded first, the fallback simply
stops firing for new photos.

### `scripts/process.js` (modified)

Becomes backfill-only for images. `photosNeedingWork` (line 195) is computed from
logical keys that **have an original in the bucket** and are missing a
derivative. Photos uploaded through the new path arrive complete and never enter
this phase; photos already in R2 as originals-only still get processed exactly as
today.

Restricting to keys with an original present is what keeps this correct: a
deferred photo has no original to download, and including it would produce a
`NoSuchKey` failure on every run until the originals are pushed.

EXIF source becomes **original if present, else `.web/`**. `fetchExifChunk`
(line 81) range-requests the first 128KB over HTTP; it just needs a URL. Existing
behaviour is byte-identical, and deferred photos read from the web derivative
that now carries their metadata.

## Error Handling

- A file sharp cannot decode fails that item only; the batch settles and the
  summary lists it, per `mapWithConcurrency`'s existing contract.
- **HEIC is rejected at validation.** Verified against this repo's sharp 0.34.5 /
  libvips 8.17.3: `metadata()` on a HEIC succeeds, but any pixel operation fails
  with `source: bad seek to <n>` where `n` exceeds the file length, for both file
  and buffer input. Since only derivatives are uploaded up front, a photo that
  cannot be resized cannot be published at all — so `.heic`/`.heif` leave
  `SUPPORTED_EXTENSIONS` and `validateFiles` rejects them with a message naming
  the `sips` conversion, rather than surfacing a raw libvips string later.
- A photo whose derivative upload failed is not added to the manifest, so a
  re-run redoes the whole photo rather than leaving a queued original with no
  images in the bucket.
- `upload-originals.js` removes an entry only after that upload resolves.
  Ctrl-C leaves the manifest accurate.
- A malformed manifest parses to `[]` rather than crashing; the originals are
  still on disk and can be re-uploaded by folder.
- Exit code 1 if any item failed, unchanged.

## Testing

`node --test`, pure units only, no R2 access — consistent with the existing
`scripts/*.test.js`.

**`keys.test.js`** (extended)
- `originalKey` inverts `webKey` and `thumbnailKey` round-trip.
- `originalKey` on a key with no derivative segment returns it unchanged.
- `logicalPhotoKeys` unions originals with `.web/`-implied keys, without
  duplicates when both are present.
- `.thumbnails/`-only keys do not, on their own, invent a photo.

**`pendingOriginals.test.js`** (new)
- `addPending` appends, and replaces rather than duplicates on a repeated key.
- `removePending` removes one entry and leaves the rest in order.
- `parsePending` returns `[]` for malformed JSON and for missing input.

**`progress.test.js`** (extended)
- `createProgressDisplay` sums `bytesTotal` from its tasks, so a task gaining a
  `total` mid-run raises the aggregate denominator and yields a finite eta.
  `renderDisplay` still reads `bytesTotal` off the state it is handed — it stays
  pure and unchanged.
- A `total: null` task still renders in count mode with its note.

**`upload-photos.test.js`** (extended)
- `parseArgs` unchanged.
- `validateFiles` reports a missing file, an unsupported extension, and rejects
  HEIC with an actionable conversion message.

**`derivatives.test.js`** (new)
- Each derivative resizes to its target width and emits JPEG.
- `makeWebSized` preserves EXIF; `makeThumbnail` drops it. This is the assertion
  the deferred-original design rests on.
- Neither enlarges a photo already smaller than its target.

**`upload.test.js`** (new)
- `contentTypeFor` maps known extensions and falls back to
  `application/octet-stream`.
- `SUPPORTED_EXTENSIONS` excludes `.heic`/`.heif`.

**`fetch-photos.test.js`** (new — `parseObjects` becomes exported, and the module
gains the entry-point guard `upload-photos.js:130` already uses, so importing it
does not run the build)
- An album builds from an original plus both derivatives.
- A photo whose original is still queued still appears, with `url` on the
  original key and `web` on the derivative.
- A deferred photo takes its date from the web derivative's `LastModified`.
- EXIF date wins over object modification time.
- Root files and non-images are ignored.
- Albums sort newest first and honour a configured cover.

The sharp resizes, the R2-effecting paths, and the live ANSI rendering are
verified manually against the real bucket, as with previous work in this repo.

## Files Touched

New: `scripts/pendingOriginals.js`, `scripts/upload-originals.js`,
`scripts/derivatives.js`, `scripts/upload.js`, and
`scripts/pendingOriginals.test.js`.

Also new: `scripts/derivatives.test.js`, `scripts/upload.test.js`,
`scripts/fetch-photos.test.js`.

Modified: `scripts/upload-photos.js`, `scripts/process.js`,
`scripts/fetch-photos.js`, `scripts/keys.js`, `scripts/progress.js`,
`scripts/keys.test.js`, `scripts/progress.test.js`,
`scripts/upload-photos.test.js`, `package.json` (adds `upload:originals`),
`.gitignore` (adds `.pending-originals.json`), `CLAUDE.md` (documents the flow).

Removed: `process.js`'s duplicated `derivedKey`/`thumbnailKey`/`webKey`.

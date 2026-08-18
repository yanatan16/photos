# Upload-time EXIF extraction and `--deploy`

Date: 2026-08-17

## Problem

`npm run upload` builds thumbnail and web derivatives, uploads both, and queues
the original — but never extracts EXIF. `exif-cache.json` is written only by
`npm run process`.

So a freshly uploaded album reaches the site with `camera`, `aperture`,
`shutter`, `iso`, and `lens` all null. Worse, `fetch-photos.js` falls back to
R2's `LastModified` for `date`, which is the *upload* time, not the capture
time. Because albums and photos are sorted chronologically and `photos[0]`
becomes the album cover and album date, a new album sorts wrong and can show
the wrong cover until someone remembers to run `npm run process`.

Separately, publishing an upload requires manually triggering the Pages
workflow, because the site is a static build that reads R2 at build time.

## Design

### 1. `scripts/exif.js` — new, pure

`parseExif(buffer)` moves verbatim out of `process.js`, along with its picked
field list. No I/O, so it is directly unit-testable against buffers generated
in memory by sharp's `.withExif()` — the pattern `derivatives.test.js` already
uses.

### 2. `scripts/exifStore.js` — new

Matches `coversStore.js` / `favoritesStore.js` / `lensOverridesStore.js`:

```js
const store = createJsonStore('exif-cache.json', {});
export const loadExifCache = store.load;
export const saveExifCache = store.save;
```

`process.js` then drops its ad-hoc `loadJson` / `saveJson`, which exist only to
serve the EXIF cache.

### 3. `upload-photos.js` — extract EXIF locally

`uploadPhoto` parses EXIF from the original buffer it has *already read from
disk*. This is a strictly richer source than what `process.js` uses: the whole
original rather than a 128KB range read, and at zero network cost.

The worker returns `{ key, exif }`, and the merge is a pure exported function:

```js
export const exifFromResults = (results) =>
  Object.fromEntries(results.filter(r => !r.error).map(r => [r.value.key, r.value.exif]));
```

Only photos that uploaded successfully are cached, matching where `queue.add`
already sits.

**Cache write:** one read-merge-write after the run, not per photo. Six
concurrent workers each serializing the whole cache object would lose updates;
batching to a single write avoids the race entirely and costs one round-trip.

```
finally:
  cache = await loadExifCache()          // fresh read, narrow window
  await saveExifCache({ ...cache, ...exifByKey })
```

**Failure handling:** if the save fails, the photos are already in R2, so warn
and point at `npm run process` rather than failing the run. `parseExif` already
swallows parse errors into `{}`; caching `{}` is correct and stops `process.js`
re-fetching an EXIF-less photo over the network on every future run.

`npm run process` stays as the backstop for photos uploaded before this change
and for anything a failed save missed.

### 4. `scripts/deploy.js` — new

First `child_process` use in the repo. `execFile` (no shell, so no injection
surface) running `gh workflow run deploy.yml`. The workflow already declares
`workflow_dispatch`.

Photos are not in git, so no commit is needed — the workflow rebuilds `main`
and re-reads R2, which is exactly the intent.

`gh workflow run` does not return the run it queued, and `gh run list`
immediately after is racy — it can return the *previous* run. Rather than poll,
print the workflow's Actions page URL, which is race-free and lists the new run
at the top.

Missing `gh`, or `gh` unauthenticated, produces a clear message.

### 5. `--deploy` semantics

- Triggers after the upload and the EXIF cache write, then prints the URL and
  exits. It does not wait; the deploy takes minutes and there is nothing to
  react to locally.
- **Skipped when any photo failed.** An incomplete album should not be
  published. The message says so and notes that re-running retries only the
  missing photos, since the skip logic already handles that. Exit code stays
  non-zero.
- **Still fires when nothing was new.** `upload -- --deploy album dir` returns
  early on "Everything is already uploaded"; deploying anyway means a forgotten
  or failed deploy can be re-run without `--force` faking new work.

### 6. npm flag passthrough — pre-existing bug

npm does not forward `--force` to the script:

```
npm run show --deploy album path    -> ["album","path"]
npm run show -- --deploy album path -> ["--deploy","album","path"]
```

`--force` is itself an npm flag, so it is absorbed silently — anyone running
`npm run upload --force ...` has been getting a normal, non-forced run. CLAUDE.md
documents it without the `--`. Fix the docs to show `npm run upload -- --force`.

## Testing

- `exif.test.js` (new) — `parseExif` against sharp-generated buffers: camera
  Make/Model join, aperture/ISO/focal formatting, the shutter `<1s` vs `>=1s`
  branches, `dateTaken` as ISO, no-EXIF and garbage-buffer both to `{}`.
- `upload-photos.test.js` — `parseArgs` learns `--deploy` (position-independent,
  combining with `--force` and `--concurrency`); `exifFromResults` drops failed
  results and maps key to exif.
- `deploy.test.js` (new) — URL construction and the missing-`gh` message, with
  the runner injected.

## Out of scope

- `upload-originals.js` does not gain `--deploy`.
- `fetch-photos.js` keeps its own `loadJson`; it reads four JSON files and
  converting one to a store would be less consistent, not more.

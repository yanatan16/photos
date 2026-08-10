# Folder Upload with Already-Uploaded Detection

**Date:** 2026-08-10
**Status:** Approved design

## Goal

Uploading a shoot means typing every filename. `scripts/upload-photos.js` takes
`<album> <file1> [file2 ...]`, so adding 200 photos means a shell glob that
matches everything — including the ones already in R2 from the last run. Every
re-run re-resizes and re-uploads photos that are already published.

Two changes, one pipeline:

1. **A trailing path may be a directory.** Directories expand to the image files
   inside them, so `npm run upload iceland-2026 ~/Pictures/Export` works.
2. **Photos already in R2 are skipped.** Before uploading, the album's existing
   keys are listed once and any photo that already has both derivatives is
   dropped from the work list.

The result is an idempotent command: point it at the folder, run it as many
times as you like, and it uploads exactly what is missing.

## Non-Goals

- **No change to the upload itself.** Local resize, sequential
  thumbnail-then-web send, pending-originals queueing, progress display, and
  `--concurrency` all stay exactly as they are.
- **No new album-naming rule.** The R2 album is still the explicit first
  argument. The local directory's name is unrelated to it.
- **No recursion.** Subdirectories inside an expanded directory are ignored.
- **No repair of missing originals.** See Known Consequences.

## CLI

The signature is unchanged. Only the meaning of the trailing arguments widens,
plus one new flag:

```
node scripts/upload-photos.js [--concurrency N] [--force] <album> <path...>
```

- `<album>` — R2 album folder, unchanged.
- `<path...>` — each is **a file or a directory**. Mixing is allowed:
  `npm run upload iceland-2026 ~/Pictures/Export ~/one-extra.jpg`
- `--force` — skip the already-uploaded check and upload every candidate,
  overwriting whatever is in R2.

`--force` does not disable validation, and it does not disable directory
expansion. It disables exactly one thing: the already-uploaded check — which
means `listAlbumKeys` is not called at all under `--force`, since its only
consumer is the filter.

## Architecture

```
argv ──→ parseArgs ──→ { album, paths, concurrency, force }
                            │
                            ▼
                     expandPaths(paths)          fs: file → itself
                            │                        dir  → immediate entries
                            ▼
                partitionCandidates(entries)     → { files, skipped, errors }
                            │
                            ▼
              listAlbumKeys(client, bucket, album)   one prefixed R2 sweep
                            │
                            ▼
            files.filter(f => force || needsUpload(presentKeys, key))
                            │
                            ▼
                  existing upload loop (unchanged)
```

## Components

### `expandPaths(paths)` → `entry[]`

Each entry is `{ filePath, explicit }`.

- A path that is a file yields itself with `explicit: true`.
- A path that is a directory yields its immediate entries with
  `explicit: false`. Subdirectories are ignored; nested files are not visited.
- A path that does not exist yields itself with `explicit: true`, so the
  existing "File not found" error still fires from the validation step rather
  than from a raw `readdir` throw.

The `explicit` tag is the whole point of this step: it records whether the user
*named* this file or whether the script *found* it. That distinction drives the
next step.

### `partitionCandidates(entries)` → `{ files, skipped, errors }`

A file the user named is a file the user wants; a problem with it is an error.
A file the script found inside a directory is just something that was in the
folder; a problem with it is not the user's mistake.

| Case | `explicit: true` | `explicit: false` |
|---|---|---|
| Supported image | upload | upload |
| Missing on disk | error | (cannot occur) |
| `.heic` / `.heif` | error, with convert hint | **skipped**, reported with convert hint |
| Other unsupported | error | **dropped silently** |

Silently dropping `.DS_Store`, `.xmp` sidecars, and RAW files is what makes
pointing at a real export folder work at all. HEIC is reported rather than
dropped because it *is* a photo the user probably wants — but one HEIC must not
block the other 200 files, which is what today's `validateFiles` would do.

`errors` is non-empty ⇒ throw the joined message, exactly as `validateFiles`
does today. `validateFiles` is subsumed by this function; its per-file checks
move here unchanged and it stops being exported separately.

### `listAlbumKeys(client, bucket, album)` → `Set<string>`

One paginated `ListObjectsV2` sweep with `Prefix: \`${album}/\``.

`listAllObjects` currently lives privately inside `process.js`. It moves to a
shared module (`scripts/r2list.js`) gaining an optional prefix parameter, and
`process.js` imports it instead of defining its own. One lister, not two.

### `needsUpload(presentKeys, key)` → `boolean`

`true` unless **both** `thumbnailKey(key)` and `webKey(key)` are present in
`presentKeys`.

Requiring both — rather than treating `.web/` alone as proof, the way
`logicalPhotoKeys` does — means a run that died between the thumbnail send and
the web send gets redone rather than left half-published.

## Output

```
14 photo(s) found in ~/Pictures/Export
9 already uploaded — skipping.
1 file(s) cannot be resized locally (.heic) — convert to JPEG to include them.

Uploading 4 photo(s) to iceland-2026/
[existing progress display]

4/4 uploaded to iceland-2026/
4 original(s) queued — run `npm run upload:originals` on fast wifi.
```

When `--force` is passed, the skip line is replaced by
`--force: uploading all 14 photo(s)`, mirroring the phrasing `process.js`
already uses for its own `--force`.

When every candidate is already uploaded, the script reports that and exits 0
without contacting R2 further.

## Error Handling

- **Explicitly-named bad file** — throws before any upload, message unchanged
  from today.
- **Directory that cannot be read** — throws with the path, before any upload.
- **Directory containing zero supported images** — not an error on its own; it
  contributes nothing. If the *total* candidate list across all paths is empty,
  the script reports "no photos to upload" and exits 0.
- **R2 listing fails** — throws. Uploading blind would defeat the feature, and
  `--force` is the explicit way to upload without listing at all.
- **Per-photo upload failure** — unchanged: recorded by the progress display,
  reported in the failure summary, `process.exitCode = 1`.

## Known Consequences

The skip rule reads derivatives only. If both derivatives are in R2 but the
original was never uploaded *and* `.pending-originals.json` was lost, a re-run
will skip that photo and the original will never be queued. Auto-re-queueing
was considered and dropped as YAGNI: the pending queue and `upload:originals`
already own that concern, and `--force` re-queues if it is ever needed.

## Testing

TDD. Extending `scripts/upload-photos.test.js`:

- `expandPaths` — against a `mkdtemp` fixture: a plain file, a directory of
  images, a directory containing a subdirectory, a mixed argument list, a
  nonexistent path.
- `partitionCandidates` — pure, over synthetic entries: every cell of the table
  above.
- `needsUpload` — pure: both derivatives present, thumbnail only, web only,
  neither.
- `parseArgs` — `--force` present, absent, and in any position; the existing
  concurrency and usage tests stay green unchanged.

The three existing `validateFiles` tests move to `partitionCandidates` as the
`explicit: true` rows of the table, since that function absorbs those checks.

`listAlbumKeys` is exercised through a stub S3 client asserting the `Prefix`
and pagination handling, matching how the other R2 helpers are covered.

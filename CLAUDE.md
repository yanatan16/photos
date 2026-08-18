# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Start local dev server (Vite)
npm run upload           # <album> <paths...> — files or folders; skips photos already in R2
npm run upload:originals # Drain queued full-size originals (run on fast wifi)
npm run process          # Backfill derivatives/EXIF for photos already in R2
npm run build:photos     # Fetch photo metadata from R2 → src/data/photos.json
npm run build:site       # Compile React app with Vite → dist/
npm run build            # Run both build steps (required before preview/deploy)
npm run preview          # Preview production build locally
```

### Passing flags

npm does not forward flags to the script unless they follow a bare `--`, and it
absorbs `--force` silently because that is one of its own options:

```bash
npm run upload --force album ~/Export      # WRONG — npm eats --force, this is a normal run
npm run upload -- --force album ~/Export   # right
```

`upload` takes `--force` (re-upload photos already in R2), `--concurrency N`, and
`--deploy` (trigger the Pages workflow when the upload finishes). `--deploy` is
skipped if any photo failed, but still fires when everything was already
uploaded — so a forgotten deploy can be re-run without `--force`.

Local dev requires `.env` with R2 credentials (see `.env.example`). Run `build:photos` first to generate `src/data/photos.json` before starting dev server.

## Architecture

Two-phase build pipeline:

1. **`scripts/fetch-photos.js`** — Node script (AWS SDK S3 client) lists all objects in Cloudflare R2, groups them by top-level folder into albums, and writes `src/data/photos.json`. Root-level files and hidden files are ignored. Album names are derived from folder slugs (`vacation-2024` → `Vacation 2024`).

2. **Vite + React app** — Imports `photos.json` at build time (static import, not a runtime fetch). Routes:
   - `/` → `AlbumGrid` — grid of album covers
   - `/album/:albumId` → `PhotoGallery` — photo grid with `PhotoViewer` lightbox overlay

`PhotoViewer` handles keyboard navigation (arrow keys, escape) and is rendered inside `PhotoGallery` when a photo is selected (controlled by index state).

The Vite `base` is set to `/photos.joneisen.me/` for GitHub Pages deployment. CI/CD runs both build steps via GitHub Actions on push to `main`, deploying to GitHub Pages.

## Data Shape

`src/data/photos.json`:
```json
{
  "albums": [
    {
      "id": "album-slug",
      "name": "Album Name",
      "cover": "https://...",
      "photos": [{ "url": "...", "thumbnail": "...", "filename": "..." }]
    }
  ]
}
```

Note: `url` points at the full-size original, which may not be uploaded yet —
it is identity, not a fetched asset. The site renders `thumbnail` (600px) and
`web` (2048px), both generated locally at upload time. `upload-photos.js` queues
originals to a gitignored `.pending-originals.json`; `upload:originals` drains it.

## EXIF

`scripts/exif.js` holds `parseExif`; `exif-cache.json` in R2 is the cache that
`fetch-photos.js` reads. Two writers fill it:

- **`upload-photos.js`** parses the full original already in memory, then does
  one read-merge-write at the end of the run. Concurrent per-photo writes of a
  single JSON object would drop each other's entries.
- **`process.js`** backfills anything missing by range-reading the first 128KB
  over HTTP, preferring the original and falling back to the `.web/` derivative
  (which is why `makeWebSized` keeps metadata and `makeThumbnail` does not).

A photo with no readable EXIF caches `{}` on purpose — that is the answer, so
`process.js` stops re-fetching it forever. `loadExifCache` throws on any read
failure other than a genuinely absent object, because both writers merge onto
what they read: a blip reported as "empty" would erase the whole cache.

Without this, a new album's `date` falls back to R2's `LastModified` — upload
time, not capture time — which mis-sorts the album and can pick the wrong cover.

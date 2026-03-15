# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Start local dev server (Vite)
npm run build:photos  # Fetch photo metadata from R2 → src/data/photos.json
npm run build:site    # Compile React app with Vite → dist/
npm run build         # Run both steps (required before preview/deploy)
npm run preview       # Preview production build locally
```

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

Note: `url` and `thumbnail` are currently identical (no separate thumbnail generation).

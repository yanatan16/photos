# Favorites — Design

## Summary

A "Favorites" view: a curated, cross-album set of photos accessible from the
header nav. Favorites are managed by a CLI script (no in-app UI), stored in R2
as the source of truth, and assembled into `photos.json` at build time. The
favorites view reuses the existing `PhotoGrid` / `PhotoViewer` and is **not** a
normal album (no cover, excluded from the album grids).

## Decisions

- **Source of truth:** `favorites.json` in R2 (mirrors `album-covers.json`).
- **Script behavior:** toggle — add if absent, remove if present.
- **Ordering:** newest photo first (by date taken), matching album sort.

## Source of truth — `favorites.json` in R2

A JSON array of photo keys, each `"<album-slug>/<filename>"` — the natural R2
object key:

```json
[
  "2026-boulder-winter/DSC01652.jpg",
  "2025-italy/DSCF1234.jpg"
]
```

Stored in the same bucket as `album-covers.json` and `exif-cache.json`. Keeping
it in R2 (not git) means favoriting is a script run, not a commit, and survives
`npm run build:photos` regeneration.

## Script — `scripts/favorite.js`

Invoked as `npm run favorite -- <album-slug> <filename>`.

- Uses the shared `scripts/r2client.js` helper (`createS3Client`,
  `getBucketName`). (The older `set-cover.js` inlines its own client; the new
  script should use the shared helper.)
- `FAVORITES_KEY = 'favorites.json'`.
- Loads the array (default `[]` if missing), computes
  `key = "<album-slug>/<filename>"`, and **toggles**: if the key is present,
  remove it; otherwise append it. Writes the array back to R2.
- Prints `Added <key> to favorites` or `Removed <key> from favorites`.
- Mirrors `set-cover.js`'s arg convention and error handling. No R2 listing is
  performed, so there is no photo-existence check (same tradeoff as
  `set-cover.js`).
- Add `"favorite": "node scripts/favorite.js"` to `package.json` scripts.

## Build — `fetch-photos.js`

After `parseObjects` assembles `albums`, load `favorites.json` (via the
existing `loadJson` helper) and build a flat `favorites` photo list by **reusing
the already-built photo objects** (no re-deriving metadata):

1. Build a `Set` of favorite keys.
2. For each album, for each photo, compute `"<album.id>/<photo.filename>"`;
   keep photos whose key is in the set.
3. Sort the result newest-first by `date` (descending), matching album sort.

Output shape becomes:

```json
{
  "albums": [ ... ],
  "favorites": [ { "url": "...", "thumbnail": "...", "web": "...", "filename": "...", "date": "...", ...exif }, ... ]
}
```

`favorites` is a **separate top-level key**, deliberately not an entry in
`albums`. This means `AlbumGrid` and `CameraGrid` require zero changes and
favorites never renders as a normal album or contributes a cover.

A favorite key that no longer matches any photo (e.g. the photo was deleted from
R2) is silently skipped.

## UI

- **`App.jsx`:** read `photosData.favorites`; add a `/favorites` route **inside
  the `Layout` element** (so the header nav tabs render and "Favorites"
  highlights as active), rendering `<FavoritesGallery favorites={favorites} />`.
- **`Layout.jsx`:** add `<NavTab to="/favorites">Favorites</NavTab>` alongside
  `All` and `Camera`.
- **`FavoritesGallery` (new component):** a title ("Favorites") plus the
  existing `<PhotoGrid photos={favorites} />`. If `favorites` is empty, render a
  short "No favorites yet" empty-state message instead of an empty grid.
- **Reuse:** `PhotoGrid` / `PhotoViewer` are used unchanged. The `?photo=`
  deep-link param and keyboard navigation work automatically since they are not
  album-specific.

## Out of scope (YAGNI)

- **No in-app heart/star button.** Favoriting is script-driven for this task. A
  local UI that supports heart/star is a likely *future* follow-up but is
  explicitly deferred — this design should not add UI affordances or app-side
  write paths for it.

## Testing / verification

- Run `npm run favorite -- <album> <file>` twice and confirm the R2
  `favorites.json` adds then removes the key, with correct console output.
- Run `npm run build:photos` and confirm `photos.json` gains a `favorites`
  array, newest-first, with full photo objects.
- In `npm run dev`: the Favorites nav tab appears and highlights when active;
  the view shows favorited photos; clicking a photo opens the viewer with deep
  link and keyboard nav; the empty state shows when there are no favorites; and
  Favorites does not appear in the All or Camera grids.

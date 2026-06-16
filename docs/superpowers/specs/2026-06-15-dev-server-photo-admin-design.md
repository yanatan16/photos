# Dev-Server Photo Admin: Deletion & Cover Selection

**Date:** 2026-06-15
**Status:** Approved design

## Goal

Extend the local dev server so that, while browsing photos in `npm run dev`, the
photographer can:

1. **Delete a photo** from R2 (original + thumbnail + web variants), with
   automatic cleanup of any favorite or album-cover reference to it.
2. **Set the album cover** by marking the currently-viewed photo as the cover.

Both controls are dev-only and live in the `PhotoViewer` toolbar, next to the
existing favorite heart. The feature reuses the favorites pattern already in the
codebase (Vite dev plugin → R2 store → React context → dev-gated UI).

## Non-Goals

- No production/runtime mutation. Everything is gated behind `import.meta.env.DEV`
  and a Vite `apply: 'serve'` plugin.
- No live update of the home `AlbumGrid` cover thumbnail — a new cover takes
  effect on the next `npm run build:photos`. The viewer reflects the active "is
  cover" state in-session.
- No undo for deletion (it is irreversible in R2). A native `confirm()` guards it.

## Architecture

Mirrors the existing favorites flow:

```
PhotoViewer (dev buttons)
   └─ useCovers / useDeletions / useFavorites  (DevToolsProvider)
        └─ fetch /__state, POST /__cover, /__delete, /__favorites
             └─ devApiServer.js  (Vite dev plugin)
                  ├─ coversStore.js   → album-covers.json
                  ├─ favoritesStore.js → favorites.json   (existing)
                  └─ deletePhoto.js   → R2 objects + reference cleanup
```

### Server side

**`scripts/keys.js` (new, shared)**
Extract the variant-key derivation currently inline in `fetch-photos.js`:

```js
export const thumbnailKey = (key) => /* …/.thumbnails/<file> */;
export const webKey = (key)       => /* …/.web/<file> */;
```

`fetch-photos.js` is refactored to import these (removing its local copies) so the
`.thumbnails/` / `.web/` convention lives in exactly one place.

**`scripts/coversStore.js` (new)**
Same shape as `favoritesStore.js`, backed by `r2client.js`:

```js
export const COVERS_KEY = 'album-covers.json';
export const loadCovers = async () => { /* GetObject → {} on miss */ };
export const saveCovers = async (covers) => { /* PutObject pretty JSON */ };
```

`scripts/set-cover.js` (the existing CLI) is refactored to use `coversStore` and
`r2client`, deleting its duplicated S3 client + load/save helpers. CLI behavior
(`node scripts/set-cover.js <album-slug> <filename>`) is unchanged.

**`scripts/deletePhoto.js` (new)**
Pure helpers + an R2-effecting `deletePhoto`:

```js
// pure
export const albumSlugFromKey = (key) => key.split('/')[0];
export const removeKey = (favorites, key) => favorites.filter(k => k !== key);
export const clearCoverIfMatches = (covers, albumSlug, filename) =>
  covers[albumSlug] === filename ? omit(covers, albumSlug) : covers;

// effect: delete original + thumbnail + web variants, then clean references
export const deletePhoto = async (key) => { … };
```

`deletePhoto(key)`:
1. Delete `key`, `thumbnailKey(key)`, `webKey(key)` from R2 (ignore missing
   variants — `DeleteObject` is idempotent).
2. Load favorites, `removeKey`, save if changed.
3. Load covers, `clearCoverIfMatches`, save if changed.

Reuses `createS3Client` / `getBucketName` from `r2client.js`.

**`scripts/devApiServer.js` (new — absorbs `favoritesDevServer.js`)**
One Vite plugin `devApiPlugin()` registering all dev endpoints, sharing the
`readBody` / `sendJson` helpers (currently duplicated in `favoritesDevServer.js`):

| Method & path     | Body      | Action                                   | Returns                |
|-------------------|-----------|------------------------------------------|------------------------|
| `GET /__state`    | —         | load favorites + covers                  | `{ favorites, covers }`|
| `POST /__favorites`| `{ key }`| toggle favorite (existing logic)         | `{ favorites, action }`|
| `POST /__cover`   | `{ key }` | set `covers[albumSlug] = filename`       | `{ covers }`           |
| `POST /__delete`  | `{ key }` | `deletePhoto(key)`                       | `{ deleted: key }`     |

`key` is the `albumSlug/filename` form produced by `favoriteKeyFromUrl(url)`.
`vite.config.js` swaps `favoritesDevPlugin()` for `devApiPlugin()`.
`favoritesDevServer.js` is removed.

### React side

**`src/context/DevToolsContext.jsx` (new — absorbs `FavoritesContext.jsx`)**
A single `DevToolsProvider` that, in dev, fetches `/__state` once and holds:

- `favorites: Set<key>`
- `covers: Record<albumSlug, filename>`
- `deleted: Set<key>` (session-only; starts empty)

Exposes three granular hooks so call sites stay focused:

- `useFavorites()` → `{ enabled, isFavorite(url), toggle(url), pending }`
  (same API as today — `PhotoViewer` import path changes only).
- `useCovers()` → `{ enabled, isCover(url), setCover(url), pending }`
  `isCover(url)` compares `covers[albumSlug] === filename` for the photo's key.
- `useDeletions()` → `{ enabled, isDeleted(url), deletePhoto(url), pending }`
  `deletePhoto` POSTs `/__delete`, then adds the key to the `deleted` Set on
  success (optimistic removal from the grid).

`main.jsx` wraps `<App/>` in `DevToolsProvider` instead of `FavoritesProvider`.
`FavoritesContext.jsx` is removed.

**`src/components/PhotoGrid.jsx`**
Filter deleted photos before rendering and before handing the list to
`PhotoViewer`, so a deleted photo disappears immediately and indices stay
consistent:

```js
const { isDeleted } = useDeletions();
const visible = photos.filter(p => !isDeleted(p.url));
```

This covers album, favorites, and camera galleries since they all render through
`PhotoGrid`.

**`src/components/PhotoViewer.jsx`**
Add two dev-only buttons in `.viewer-info`, beside the favorite heart:

- **Set as cover** — `CoverIcon`, gains an `is-cover` active class when
  `isCover(currentPhoto.url)`; `onClick={() => setCover(currentPhoto.url)}`;
  disabled while `pending`.
- **Delete** — `TrashIcon`; `onClick` runs
  `if (confirm(\`Delete "${currentPhoto.filename}"? This removes it from R2 permanently.\`))`
  then `deletePhoto(currentPhoto.url)` and advances: navigate to the next photo,
  or `onClose()` if it was the last. Because the grid filters the deleted photo
  out, the viewer's `photos` array shrinks and the index lands on the following
  photo naturally.

New SVG icon components (`CoverIcon`, `TrashIcon`) follow the existing
`HeartIcon` / `CloseIcon` style. CSS additions in `PhotoViewer.css` mirror
`.viewer-favorite`.

## Error Handling

- All endpoints wrap handlers in try/catch and `sendJson(res, 500, { error })`,
  matching the existing favorites plugin.
- Missing R2 variants on delete are ignored (idempotent `DeleteObject`).
- On client fetch failure, hooks `console.warn` and leave state unchanged (a
  failed delete therefore does NOT optimistically remove the photo).
- If `/__state` fails on mount, `enabled` stays false and the dev buttons hide —
  identical to today's favorites degradation.

## Testing

Follow `scripts/favorites.test.js` (pure-function unit tests, no R2):

- `keys.js`: `thumbnailKey` / `webKey` for nested and root-level filenames.
- `deletePhoto.js` pure helpers: `albumSlugFromKey`, `removeKey`,
  `clearCoverIfMatches` (matching, non-matching, absent).

R2-effecting paths (`deletePhoto`, store load/save, endpoints) are verified
manually in `npm run dev` against the real bucket, consistent with how favorites
was validated.

## Files Touched

New: `scripts/keys.js`, `scripts/coversStore.js`, `scripts/deletePhoto.js`,
`scripts/devApiServer.js`, `src/context/DevToolsContext.jsx`,
`scripts/keys.test.js`, `scripts/deletePhoto.test.js`.

Modified: `scripts/fetch-photos.js`, `scripts/set-cover.js`, `vite.config.js`,
`src/main.jsx`, `src/components/PhotoGrid.jsx`,
`src/components/PhotoViewer.jsx`, `src/components/PhotoViewer.css`.

Removed: `scripts/favoritesDevServer.js`, `src/context/FavoritesContext.jsx`.

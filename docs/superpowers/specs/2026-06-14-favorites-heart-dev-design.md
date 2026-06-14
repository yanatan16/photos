# Dev-only Favorites Heart — Design

## Summary

Add a heart button to the photo viewer that toggles a photo's favorite status by
clicking, instead of running the `npm run favorite` CLI. Because the deployed
site is a static GitHub Pages app with no backend, this is a **development-only**
affordance: the heart renders and works only under `npm run dev`, backed by a
small Vite dev-server middleware that writes to the same R2 `favorites.json`
used by the CLI. A production build does not include the write path and does not
show the heart.

This builds on the existing Favorites feature (CLI script, `favorites.json` in
R2, build-time `favorites` array in `photos.json`, Favorites view).

## Decisions

- **Write target:** directly to R2 `favorites.json` (one source of truth; same as
  the CLI). Clicking the heart is equivalent to running `npm run favorite`.
- **Initial state:** live read from R2 via a GET endpoint, so the heart shows the
  correct filled/empty state even before a rebuild.
- **Placement:** in the viewer's info row, next to the download (↓) control.

## 1. Shared R2 favorites store — `scripts/favoritesStore.js` (new)

Extract the R2 I/O currently inlined in `scripts/favorite.js` into a reusable
module:

- `FAVORITES_KEY = 'favorites.json'`
- `loadFavorites()` → returns the parsed array, or `[]` on any error (missing
  object). Creates the S3 client and bucket name via the existing
  `scripts/r2client.js` helpers.
- `saveFavorites(favorites)` → PUTs `JSON.stringify(favorites, null, 2)` with
  `ContentType: 'application/json'`.

Then refactor `scripts/favorite.js` to import `loadFavorites`/`saveFavorites`
from this module instead of defining them inline. No change to the CLI's
observable behavior.

## 2. Vite dev middleware — `scripts/favoritesDevServer.js` (new)

Export `favoritesDevPlugin()`, a Vite plugin with `apply: 'serve'` (active only
during `npm run dev`, never in `vite build`). It registers a single middleware
mounted at `/__favorites`:

- `GET /__favorites` → `200 { favorites: [keys] }` from `loadFavorites()`.
- `POST /__favorites` with JSON body `{ key }`:
  - `400 { error }` if `key` is missing.
  - otherwise: `loadFavorites()`, run the existing pure `toggleFavorite(current,
    key)`, `saveFavorites(favorites)`, return `200 { favorites, action }`.
- Any thrown error (e.g. missing R2 credentials) → `500 { error: message }`.

The handler reads the request body from the Node stream and reuses
`favoritesStore.js` plus the pure `toggleFavorite` from `scripts/favorites.js` —
so a heart click is exactly equivalent to running `npm run favorite`.

Register it in `vite.config.js`: `plugins: [react(), favoritesDevPlugin()]`.

A distinct `/__favorites` prefix avoids collision with the SPA's client routes.

## 3. Key derivation — add to `scripts/favorites.js`

Add a pure, node-testable helper:

```js
export const favoriteKeyFromUrl = (url) => new URL(url).pathname.replace(/^\/+/, '');
```

A photo's `url` is the full R2 public URL
(`https://pub-….r2.dev/2026-boulder-winter/DSC01652.jpg`), so its pathname minus
the leading slash is `2026-boulder-winter/DSC01652.jpg` — identical to the CLI's
`favoriteKey(albumSlug, filename)` format. This lets the heart compute the key
from the photo object alone, working the same in the album view and the
favorites view (where the album id isn't otherwise available) without threading
album ids through routes/props.

The React client imports this single helper from `scripts/favorites.js`.

## 4. Client state — `src/context/FavoritesContext.jsx` (new)

A context provider wrapping `<App>` (added in `src/main.jsx`):

- On mount, **only when `import.meta.env.DEV`**, fetch `GET /__favorites` and
  store the keys in a `Set`.
- Exposes:
  - `enabled` — `true` only when in dev AND the initial GET succeeded.
  - `isFavorite(url)` — `keys.has(favoriteKeyFromUrl(url))`.
  - `toggle(url)` — POSTs the derived key; on success replaces the key set from
    the response's `favorites`.
  - `pending` — true while a toggle request is in flight (to disable the button).
- In production, or if the initial GET fails (e.g. missing R2 credentials),
  `enabled` is `false` and the provider is an inert no-op. No network calls in a
  production build.

## 5. The heart — `PhotoViewer.jsx` + `PhotoViewer.css`

- Consume the favorites context in `PhotoViewer`.
- When `enabled`, render an SVG heart button in the existing `.viewer-info` row,
  next to the download link: **filled** when `isFavorite(currentPhoto.url)`,
  **outline** otherwise. Clicking calls `toggle(currentPhoto.url)`; the button is
  disabled while `pending`.
- Use an inline SVG (consistent with the chevron approach already in this file)
  so fill/outline is controlled via `fill`/`stroke`. Style to match the existing
  download control (muted color, hover brighten); the filled state reads clearly
  as "favorited".
- `aria-label` reflects state ("Add to favorites" / "Remove from favorites").

## Error handling

- Missing R2 credentials or any R2 failure during the initial GET → `enabled`
  stays `false`, heart is not rendered (no broken affordance).
- A failed `toggle` POST → log a warning and leave the icon state unchanged; the
  button re-enables. (No optimistic flip that could desync from R2.)

## Testing / verification

- **Automated:** `favoriteKeyFromUrl` gets `node:test` cases in
  `scripts/favorites.test.js` (full URL → key; trailing/leading slash handling).
  Existing tests continue to pass. `scripts/favorite.js` still works after the
  store refactor (its pure logic is already covered; run it once with no args to
  confirm the usage path).
- **Manual (dev):** run `npm run dev`, open a photo, click the heart →
  `favorites.json` in R2 updates; the icon fills; `npm run favorite -- <album>
  <file>` on the same photo reports it as already favorited / toggles it off,
  confirming both paths share one source of truth. Reload to confirm the live
  GET reflects the persisted state. Confirm a production `vite build` contains no
  `/__favorites` calls and the heart is absent.

## Out of scope (YAGNI)

- No heart on grid thumbnails — viewer only.
- No authentication on the dev endpoint (localhost-only, dev-only).
- The favorites **grid** still reflects the last `build:photos`: a photo
  unfavorited via the heart updates the icon immediately but disappears from the
  Favorites grid only after the next `build:photos`. This matches the existing
  build model and is acceptable.

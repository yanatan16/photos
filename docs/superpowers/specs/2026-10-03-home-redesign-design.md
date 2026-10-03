# Home Redesign — Design

## Summary

The landing page (`/`) becomes a curated front door: the latest favorite
photos first, then the latest albums. The full albums grid and the full
favorites page are preserved and linked from the new home.

## Decisions

- **Layout:** favorites first, then latest albums.
- **Favorites shown:** the latest 8. `favorites` in `photos.json` is already
  sorted newest-first by date taken (`buildFavorites`), so this is the first 8.
- **Albums shown:** the 4 newest. `albums` is already sorted newest-first
  (`fetch-photos.js`).
- **No build-pipeline changes.** Everything needed is in `photos.json`.

## Routes

| Path | Before | After |
|------|--------|-------|
| `/` | `AlbumGrid` (all albums) | `Home` |
| `/albums` | — | `AlbumGrid` (unchanged) |
| `/favorites` | `FavoritesGallery` | unchanged |
| `/camera`, `/camera/:cameraSlug` | unchanged | unchanged |
| `/album/:albumId` | `PhotoGallery` | unchanged |

Nav tabs: **Home** (`/`, exact), **Albums**, **Favorites**, **Camera**.

## Home page

1. **Favorites section** — `SectionHeader` ("Favorites", link "See all →" to
   `/favorites`), then `PhotoGrid` with `favorites.slice(0, 8)`. Reusing
   `PhotoGrid` keeps the lightbox, deletion filtering and `?photo=` deep links.
   Hidden when there are no favorites.
2. **Latest albums section** — `SectionHeader` ("Latest albums", link
   "All albums →" to `/albums`), then the 4 newest albums as `AlbumCard`s in
   the existing `.album-grid`.

## Code

- `src/components/Home.jsx` — composes the two sections.
- `src/components/SectionHeader.jsx` — title plus link; used twice (DRY).
- `src/components/AlbumCard.jsx` — extracted from `AlbumGrid.jsx` so `Home`
  and `AlbumGrid` share it.
- `src/utils/latest.js` — pure `latest(items, n)`; unit-tested
  (`latest.test.js`), including `n` larger than the list and an empty list.
- `src/App.jsx` — route changes above.
- `src/components/Layout.jsx` — nav tabs.
- `src/components/AlbumGrid.css` — section header styles, beside the existing
  styles.

## Edge cases

- Fewer than 8 favorites or 4 albums: show what exists.
- Zero favorites: omit the favorites section.
- Old `#/` bookmarks land on the new home, which links onward to the albums.

## Testing

- Unit test for `latest`.
- `npm run build` succeeds.
- Manual check in `npm run dev`: home sections, both "see all" links, all four
  nav tabs, lightbox opening from a home favorite, and back/close returning to
  home.

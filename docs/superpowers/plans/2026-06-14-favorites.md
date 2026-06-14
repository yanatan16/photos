# Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a script-managed "Favorites" view — a curated cross-album photo set accessible from the header nav.

**Architecture:** Favorites live in R2 as `favorites.json` (array of `"<album-slug>/<filename>"` keys). A CLI script toggles entries. `fetch-photos.js` reads the list at build time and emits a `favorites` photo array into `photos.json`. The React app renders it via the existing `PhotoGrid`/`PhotoViewer`. Pure logic (toggle, build) lives in a shared `scripts/favorites.js` module, unit-tested with Node's built-in `node:test`.

**Tech Stack:** Node 18+ (ESM, `node:test`), AWS SDK S3 client (R2), React 18, react-router-dom v6, Vite.

**Note on testing:** Only the pure-logic module (Task 1) has automated tests. Tasks 2–4 involve R2 network I/O and React UI, which this project has no harness for — they use explicit manual verification, consistent with the design's testing section.

---

### Task 1: Pure favorites logic module (`scripts/favorites.js`)

**Files:**
- Create: `scripts/favorites.js`
- Test: `scripts/favorites.test.js`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Write the failing tests**

Create `scripts/favorites.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoriteKey, toggleFavorite, buildFavorites } from './favorites.js';

test('favoriteKey joins album slug and filename', () => {
  assert.equal(favoriteKey('2025-italy', 'a.jpg'), '2025-italy/a.jpg');
});

test('toggleFavorite adds a missing key', () => {
  const { favorites, action } = toggleFavorite([], 'x/a.jpg');
  assert.deepEqual(favorites, ['x/a.jpg']);
  assert.equal(action, 'added');
});

test('toggleFavorite removes an existing key', () => {
  const { favorites, action } = toggleFavorite(['x/a.jpg', 'y/b.jpg'], 'x/a.jpg');
  assert.deepEqual(favorites, ['y/b.jpg']);
  assert.equal(action, 'removed');
});

test('buildFavorites selects matching photos, newest first, skips missing', () => {
  const albums = [
    { id: 'a', photos: [
      { filename: 'old.jpg', date: '2020-01-01T00:00:00.000Z' },
      { filename: 'new.jpg', date: '2024-01-01T00:00:00.000Z' },
    ] },
    { id: 'b', photos: [
      { filename: 'mid.jpg', date: '2022-01-01T00:00:00.000Z' },
    ] },
  ];
  const result = buildFavorites(albums, ['a/old.jpg', 'b/mid.jpg', 'missing/x.jpg']);
  assert.deepEqual(result.map(p => p.filename), ['mid.jpg', 'old.jpg']);
});

test('buildFavorites returns [] when there are no favorites', () => {
  const albums = [{ id: 'a', photos: [{ filename: 'x.jpg', date: null }] }];
  assert.deepEqual(buildFavorites(albums, []), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/favorites.test.js`
Expected: FAIL — cannot find module `./favorites.js` (or import errors).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/favorites.js`:

```js
export const favoriteKey = (albumSlug, filename) => `${albumSlug}/${filename}`;

export const toggleFavorite = (favorites, key) => {
  if (favorites.includes(key)) {
    return { favorites: favorites.filter(k => k !== key), action: 'removed' };
  }
  return { favorites: [...favorites, key], action: 'added' };
};

export const buildFavorites = (albums, favoriteKeys) => {
  const favoriteSet = new Set(favoriteKeys);
  return albums
    .flatMap(album =>
      album.photos.map(photo => ({ photo, key: favoriteKey(album.id, photo.filename) }))
    )
    .filter(({ key }) => favoriteSet.has(key))
    .map(({ photo }) => photo)
    .sort((a, b) => {
      const da = a.date ? new Date(a.date) : new Date(0);
      const db = b.date ? new Date(b.date) : new Date(0);
      return db - da;
    });
};
```

- [ ] **Step 4: Add the `test` script to `package.json`**

In the `scripts` block of `package.json`, add (after `"dev"`):

```json
    "test": "node --test",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/favorites.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 6: Commit**

```bash
git add scripts/favorites.js scripts/favorites.test.js package.json
git commit -m "Add pure favorites logic (toggle + build) with tests"
```

---

### Task 2: Favorite CLI script (`scripts/favorite.js`)

**Files:**
- Create: `scripts/favorite.js`
- Modify: `package.json` (add `favorite` script)

Reuses `scripts/r2client.js` (`createS3Client`, `getBucketName`) and `scripts/favorites.js` (`toggleFavorite`, `favoriteKey`). No automated test (R2 network I/O); the toggle logic is already covered by Task 1. Verified manually in Step 4.

- [ ] **Step 1: Write the script**

Create `scripts/favorite.js`:

```js
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';
import { toggleFavorite, favoriteKey } from './favorites.js';

const FAVORITES_KEY = 'favorites.json';

const loadFavorites = async (client, bucketName) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: FAVORITES_KEY }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return [];
  }
};

const saveFavorites = async (client, bucketName, favorites) => {
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: FAVORITES_KEY,
    Body: JSON.stringify(favorites, null, 2),
    ContentType: 'application/json',
  }));
};

const run = async () => {
  const [albumSlug, filename] = process.argv.slice(2);

  if (!albumSlug || !filename) {
    throw new Error('Usage: npm run favorite -- <album-slug> <photo-filename>');
  }

  const bucketName = getBucketName();
  const client = createS3Client();

  const current = await loadFavorites(client, bucketName);
  const key = favoriteKey(albumSlug, filename);
  const { favorites, action } = toggleFavorite(current, key);
  await saveFavorites(client, bucketName, favorites);

  console.log(action === 'added'
    ? `Added ${key} to favorites`
    : `Removed ${key} from favorites`);
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `favorite` script to `package.json`**

In the `scripts` block of `package.json`, add (next to `"set-cover"`):

```json
    "favorite": "node scripts/favorite.js",
```

- [ ] **Step 3: Verify usage error without args**

Run: `npm run favorite`
Expected: prints `Error: Usage: npm run favorite -- <album-slug> <photo-filename>` and exits non-zero.

- [ ] **Step 4: Manually verify the round-trip against R2**

Requires `.env` with R2 credentials. Pick a real album slug + filename from `src/data/photos.json`, e.g. `2026-boulder-winter DSC01652.jpg`.

Run: `npm run favorite -- 2026-boulder-winter DSC01652.jpg`
Expected: `Added 2026-boulder-winter/DSC01652.jpg to favorites`

Run the same command again:
Expected: `Removed 2026-boulder-winter/DSC01652.jpg from favorites`

Then re-add it so there is data for later tasks:
Run: `npm run favorite -- 2026-boulder-winter DSC01652.jpg`
Expected: `Added ...`

- [ ] **Step 5: Commit**

```bash
git add scripts/favorite.js package.json
git commit -m "Add favorite CLI script to toggle favorites in R2"
```

---

### Task 3: Wire favorites into the build (`scripts/fetch-photos.js`)

**Files:**
- Modify: `scripts/fetch-photos.js`

Two changes: give `loadJson` a configurable fallback (so a missing `favorites.json` yields `[]`, not `{}`), and build + emit the `favorites` array.

- [ ] **Step 1: Import `buildFavorites`**

At the top of `scripts/fetch-photos.js`, after the existing imports, add:

```js
import { buildFavorites } from './favorites.js';
```

- [ ] **Step 2: Add a fallback parameter to `loadJson`**

Replace the existing `loadJson` definition:

```js
const loadJson = async (client, bucketName, key) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return {};
  }
};
```

with:

```js
const loadJson = async (client, bucketName, key, fallback = {}) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return fallback;
  }
};
```

(Existing `exif-cache.json` and `album-covers.json` callers keep the `{}` default — no change needed there.)

- [ ] **Step 3: Load favorites and build the favorites array**

In `generateMetadata`, locate:

```js
  console.log('Parsing album structure...');
  const albums = parseObjects(objects, publicUrl, exifCache, albumCovers);
  console.log(`Generated ${albums.length} albums`);

  const metadata = { albums };
```

Replace it with:

```js
  console.log('Loading favorites...');
  const favoriteKeys = await loadJson(client, bucketName, 'favorites.json', []);
  console.log(`Favorites: ${favoriteKeys.length} configured`);

  console.log('Parsing album structure...');
  const albums = parseObjects(objects, publicUrl, exifCache, albumCovers);
  console.log(`Generated ${albums.length} albums`);

  const favorites = buildFavorites(albums, favoriteKeys);
  console.log(`Resolved ${favorites.length} favorite photos`);

  const metadata = { albums, favorites };
```

- [ ] **Step 4: Manually verify the build output**

Requires `.env` and the favorite added in Task 2 Step 4.

Run: `npm run build:photos`
Expected: log includes `Favorites: 1 configured` and `Resolved 1 favorite photos`.

Then confirm the output shape:

Run: `node -e "const d=require('./src/data/photos.json'); console.log(Array.isArray(d.favorites), d.favorites.length, d.favorites[0] && d.favorites[0].filename)"`
Expected: `true 1 DSC01652.jpg` (a `favorites` array containing the full photo object).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-photos.js
git commit -m "Build favorites array into photos.json"
```

---

### Task 4: Favorites view in the app

**Files:**
- Create: `src/components/FavoritesGallery.jsx`
- Modify: `src/App.jsx`
- Modify: `src/components/Layout.jsx`

Reuses the existing `PhotoGrid` and `PhotoGallery.css` classes. Rendered inside `Layout` so the header nav shows and the Favorites tab highlights. No automated test (no React test runner); verified manually in the dev server.

- [ ] **Step 1: Create the `FavoritesGallery` component**

Create `src/components/FavoritesGallery.jsx`:

```jsx
import PhotoGrid from './PhotoGrid';
import './PhotoGallery.css';

const FavoritesGallery = ({ favorites }) => (
  <div className="photo-gallery-container">
    <header className="gallery-header">
      <h1 className="gallery-title">Favorites</h1>
      <p className="gallery-count">{favorites.length} photos</p>
    </header>
    {favorites.length === 0
      ? <p className="error-message">No favorites yet</p>
      : <PhotoGrid photos={favorites} />}
  </div>
);

export default FavoritesGallery;
```

- [ ] **Step 2: Add the route in `App.jsx`**

In `src/App.jsx`, add the import after the other component imports:

```jsx
import FavoritesGallery from './components/FavoritesGallery';
```

After `const albums = photosData.albums;`, add:

```jsx
const favorites = photosData.favorites ?? [];
```

Inside the `<Route element={<Layout />}>` block, add the favorites route after the `/` route:

```jsx
          <Route path="/favorites" element={<FavoritesGallery favorites={favorites} />} />
```

The block should read:

```jsx
        <Route element={<Layout />}>
          <Route path="/" element={<AlbumGrid albums={albums} />} />
          <Route path="/favorites" element={<FavoritesGallery favorites={favorites} />} />
          <Route path="/camera" element={<CameraGrid albums={albums} />} />
          <Route path="/camera/:cameraSlug" element={<CameraPhotos albums={albums} />} />
        </Route>
```

- [ ] **Step 3: Add the nav tab in `Layout.jsx`**

In `src/components/Layout.jsx`, update the nav so it reads:

```jsx
    <nav className="album-nav">
      <NavTab to="/" end>All</NavTab>
      <NavTab to="/favorites">Favorites</NavTab>
      <NavTab to="/camera">Camera</NavTab>
    </nav>
```

- [ ] **Step 4: Manually verify in the dev server**

Run: `npm run dev` (if not already running) and open the local URL.

Verify:
- A "Favorites" tab appears in the header between "All" and "Camera", and highlights as active when on `/favorites`.
- The Favorites view shows the favorited photo(s) in a grid with the count.
- Clicking a photo opens the viewer; the URL gains `?photo=N`; left/right arrow keys and on-screen arrows navigate; Escape closes.
- Favorites does **not** appear as an album in the All grid or the Camera views.
- Empty state: temporarily test by removing the favorite (`npm run favorite -- 2026-boulder-winter DSC01652.jpg`) then `npm run build:photos` and reload — the view shows "No favorites yet". Re-add it afterward and rebuild.

- [ ] **Step 5: Commit**

```bash
git add src/components/FavoritesGallery.jsx src/App.jsx src/components/Layout.jsx
git commit -m "Add Favorites view and header nav tab"
```

---

## Done criteria

- `npm run favorite -- <album> <file>` toggles an entry in R2 `favorites.json`.
- `npm run build:photos` emits a newest-first `favorites` array in `photos.json`.
- The app shows a Favorites header tab and view that reuses the grid/viewer, with an empty state, and favorites never appear as a normal album.

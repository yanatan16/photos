# Home Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/` a curated home (latest 8 favorites, 4 newest albums) while keeping the full albums and favorites pages linked from it.

**Architecture:** A new `Home` component composes two sections from data already in `photos.json` (both lists are pre-sorted newest-first). The existing all-albums grid moves to `/albums`. Shared pieces (`AlbumCard`, `SectionHeader`, `latest`) are extracted so nothing is duplicated.

**Tech Stack:** React 18, react-router-dom (HashRouter), Vite, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-10-03-home-redesign-design.md`

## Global Constraints

- Latest favorites shown on home: 8. Newest albums shown: 4.
- No build-pipeline (`scripts/`) changes.
- `/favorites`, `/camera`, `/camera/:cameraSlug`, `/album/:albumId` routes are unchanged.
- Nav tabs, in order: Home (`/`, exact), Albums (`/albums`), Favorites, Camera.
- Spec addendum: `PhotoGallery`'s "← Back to Albums" links must point to `/albums`, not `/`.
- Tests run with `npm test` (`node --test`); JSX components are verified by `npm run build` plus a manual check.

## Review Focus

- Fewer than 8 favorites / 4 albums: show what exists, no crash (`latest` test).
- Zero favorites: favorites section is omitted entirely (manual check).
- `latest` with `n` of 0 or an empty list returns `[]` (test).
- `latest` must not mutate its input (test).
- Back button in an album returns to `/albums`, not home (manual check).

---

### Task 1: `latest` helper

**Files:**
- Create: `src/utils/latest.js`
- Test: `src/utils/latest.test.js`

**Interfaces:**
- Produces: `latest(items: Array, n: number): Array` — the first `n` items, as a new array.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latest } from './latest.js';

test('returns the first n items', () => {
  assert.deepEqual(latest([1, 2, 3, 4], 2), [1, 2]);
});

test('returns everything when n exceeds the length', () => {
  assert.deepEqual(latest([1, 2], 8), [1, 2]);
});

test('returns an empty array for an empty list or n of 0', () => {
  assert.deepEqual(latest([], 4), []);
  assert.deepEqual(latest([1, 2], 0), []);
});

test('does not mutate its input', () => {
  const items = [1, 2, 3];
  latest(items, 2);
  assert.deepEqual(items, [1, 2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/utils/latest.test.js`
Expected: FAIL with `Cannot find module './latest.js'`

- [ ] **Step 3: Write minimal implementation**

```js
export const latest = (items, n) => items.slice(0, n);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/utils/latest.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/latest.js src/utils/latest.test.js
git commit -m "Add latest helper"
```

---

### Task 2: Extract `AlbumCard`, add `SectionHeader`

**Files:**
- Create: `src/components/AlbumCard.jsx`, `src/components/SectionHeader.jsx`
- Modify: `src/components/AlbumGrid.jsx`, `src/components/AlbumGrid.css` (append)

**Interfaces:**
- Produces: `AlbumCard({ album })` (default export), `SectionHeader({ title, to, linkText })` (default export).

- [ ] **Step 1: Create `AlbumCard.jsx`** by moving `formatDate` and `AlbumCard` out of `AlbumGrid.jsx` verbatim:

```jsx
import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const formatDate = (isoDate) => {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
};

const AlbumCard = ({ album }) => (
  <Link to={`/album/${album.id}`} className="album-card">
    <div className="album-cover">
      <img src={album.cover} alt={album.name} loading="lazy" />
    </div>
    <div className="album-info">
      <h2 className="album-title">
        {album.year && <span className="album-year">{album.year}</span>}
        {album.name}
      </h2>
      {album.firstPhotoDate && (
        <p className="album-date">{formatDate(album.firstPhotoDate)}</p>
      )}
      <p className="album-count">{album.photos.length} photos</p>
    </div>
  </Link>
);

export default AlbumCard;
```

- [ ] **Step 2: Replace `AlbumGrid.jsx`** with:

```jsx
import AlbumCard from './AlbumCard';
import './AlbumGrid.css';

const AlbumGrid = ({ albums }) => (
  <div className="album-grid">
    {albums.map(album => <AlbumCard key={album.id} album={album} />)}
  </div>
);

export default AlbumGrid;
```

- [ ] **Step 3: Create `SectionHeader.jsx`**

```jsx
import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const SectionHeader = ({ title, to, linkText }) => (
  <div className="section-header">
    <h2 className="section-title">{title}</h2>
    <Link to={to} className="section-link">{linkText}</Link>
  </div>
);

export default SectionHeader;
```

- [ ] **Step 4: Append CSS to `AlbumGrid.css`**

```css
.home-section {
  margin-bottom: 3rem;
}

.section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: #fff;
}

.section-link {
  font-size: 0.9rem;
  color: #888;
  text-decoration: none;
}

.section-link:hover {
  color: #fff;
}
```

- [ ] **Step 5: Verify the build still passes**

Run: `npm run build:site`
Expected: build succeeds (needs `src/data/photos.json`; run `npm run build:photos` first if missing and `.env` is present, otherwise copy it from the main checkout's `src/data/`).

- [ ] **Step 6: Commit**

```bash
git add src/components/AlbumCard.jsx src/components/SectionHeader.jsx src/components/AlbumGrid.jsx src/components/AlbumGrid.css
git commit -m "Extract AlbumCard and add SectionHeader"
```

---

### Task 3: `Home` page, routes, nav, back links

**Files:**
- Create: `src/components/Home.jsx`
- Modify: `src/App.jsx`, `src/components/Layout.jsx:17`, `src/components/PhotoGallery.jsx:13,21`

**Interfaces:**
- Consumes: `latest(items, n)`, `AlbumCard({ album })`, `SectionHeader({ title, to, linkText })`, existing `PhotoGrid({ photos })`, `AlbumGrid({ albums })`.
- Produces: `Home({ albums, favorites })` (default export).

- [ ] **Step 1: Create `Home.jsx`**

```jsx
import AlbumCard from './AlbumCard';
import PhotoGrid from './PhotoGrid';
import SectionHeader from './SectionHeader';
import { latest } from '../utils/latest';
import './AlbumGrid.css';

const FAVORITES_SHOWN = 8;
const ALBUMS_SHOWN = 4;

const Home = ({ albums, favorites }) => (
  <>
    {favorites.length > 0 && (
      <section className="home-section">
        <SectionHeader title="Favorites" to="/favorites" linkText="See all →" />
        <PhotoGrid photos={latest(favorites, FAVORITES_SHOWN)} />
      </section>
    )}
    <section className="home-section">
      <SectionHeader title="Latest albums" to="/albums" linkText="All albums →" />
      <div className="album-grid">
        {latest(albums, ALBUMS_SHOWN).map(album => <AlbumCard key={album.id} album={album} />)}
      </div>
    </section>
  </>
);

export default Home;
```

- [ ] **Step 2: Update `App.jsx`** — add `import Home from './components/Home';` and replace the `/` route:

```jsx
<Route path="/" element={<Home albums={albums} favorites={favorites} />} />
<Route path="/albums" element={<AlbumGrid albums={albums} />} />
```

- [ ] **Step 3: Update nav in `Layout.jsx`** — replace the `All` tab line with:

```jsx
<NavTab to="/" end>Home</NavTab>
<NavTab to="/albums">Albums</NavTab>
```

- [ ] **Step 4: Fix back links in `PhotoGallery.jsx`** — change both `<Link to="/" className="back-button">` (lines 13 and 21) to `to="/albums"`.

- [ ] **Step 5: Run unit tests and build**

Run: `npm test && npm run build:site`
Expected: all tests pass, build succeeds.

- [ ] **Step 6: Manual check**

Run: `npm run dev`, then verify at the printed URL:
- Home shows favorites (max 8) then 4 albums; "See all →" opens `/favorites`; "All albums →" opens `/albums`.
- Nav tabs Home / Albums / Favorites / Camera highlight correctly (Home only on `/`).
- Clicking a home favorite opens the lightbox; closing it returns to home.
- An album's "← Back to Albums" goes to `/albums`.

- [ ] **Step 7: Commit**

```bash
git add src/components/Home.jsx src/App.jsx src/components/Layout.jsx src/components/PhotoGallery.jsx
git commit -m "Add home page with latest favorites and albums"
```

---

### Task 4: Docs

**Files:**
- Modify: `CLAUDE.md` (Architecture routes list)

- [ ] **Step 1:** In the Routes list, replace the `/` → `AlbumGrid` line with `/` → `Home` (latest 8 favorites + 4 newest albums), and add `/albums` → `AlbumGrid`, `/favorites` → `FavoritesGallery`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document new home and albums routes"
```

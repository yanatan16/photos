# Dev-Server Photo Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dev-only photo deletion and album-cover selection to the local Vite dev server, reusing the existing favorites pattern.

**Architecture:** A single Vite dev plugin (`devApiServer.js`) exposes R2-backed endpoints; a single React provider (`DevToolsProvider`) holds favorites/covers/deletions state and exposes granular hooks; `PhotoViewer` gains dev-only cover + delete buttons; `PhotoGrid` filters out deleted photos. Shared R2 logic is extracted into `keys.js`, `coversStore.js`, and `deletePhoto.js`.

**Tech Stack:** Node 20 + `@aws-sdk/client-s3`, Vite 6 dev middleware, React 18 context, `node:test` for unit tests.

---

## File Structure

New files:
- `scripts/keys.js` — variant-key derivation (`thumbnailKey`, `webKey`), extracted from `fetch-photos.js`.
- `scripts/keys.test.js` — unit tests for the above.
- `scripts/coversStore.js` — load/save `album-covers.json` via `r2client.js`.
- `scripts/deletePhoto.js` — pure key/reference helpers + R2-effecting `deletePhoto`.
- `scripts/deletePhoto.test.js` — unit tests for the pure helpers.
- `scripts/devApiServer.js` — one Vite plugin wiring `/__state`, `/__favorites`, `/__cover`, `/__delete`.
- `src/context/DevToolsContext.jsx` — provider + `useFavorites` / `useCovers` / `useDeletions` hooks.

Modified files:
- `scripts/fetch-photos.js` — import `thumbnailKey`/`webKey` from `keys.js` instead of local copies.
- `scripts/set-cover.js` — use `coversStore.js`, drop duplicated S3 client/load/save.
- `vite.config.js` — use `devApiPlugin()` instead of `favoritesDevPlugin()`.
- `src/main.jsx` — wrap app in `DevToolsProvider`.
- `src/components/PhotoGrid.jsx` — filter deleted photos.
- `src/components/PhotoViewer.jsx` — cover + delete buttons, delete handler.
- `src/components/PhotoViewer.css` — styles for the new buttons.

Removed files:
- `scripts/favoritesDevServer.js` (absorbed into `devApiServer.js`).
- `src/context/FavoritesContext.jsx` (absorbed into `DevToolsContext.jsx`).

---

## Task 1: Extract shared variant-key helpers

**Files:**
- Create: `scripts/keys.js`
- Test: `scripts/keys.test.js`
- Modify: `scripts/fetch-photos.js:71-81` (remove local helpers), `scripts/fetch-photos.js:6` area (add import)

- [ ] **Step 1: Write the failing test**

Create `scripts/keys.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailKey, webKey } from './keys.js';

test('thumbnailKey inserts .thumbnails before the filename', () => {
  assert.equal(thumbnailKey('2025-italy/a.jpg'), '2025-italy/.thumbnails/a.jpg');
});

test('webKey inserts .web before the filename', () => {
  assert.equal(webKey('2025-italy/a.jpg'), '2025-italy/.web/a.jpg');
});

test('thumbnailKey handles nested paths', () => {
  assert.equal(thumbnailKey('a/b/c.jpg'), 'a/b/.thumbnails/c.jpg');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/keys.test.js`
Expected: FAIL — `Cannot find module './keys.js'`.

- [ ] **Step 3: Create `scripts/keys.js`**

```js
export const thumbnailKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.thumbnails', filename].join('/');
};

export const webKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.web', filename].join('/');
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/keys.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor `scripts/fetch-photos.js` to use the shared helpers**

Add to the import block near the top (after line 6, `import { buildFavorites } from './favorites.js';`):

```js
import { thumbnailKey, webKey } from './keys.js';
```

Delete the now-duplicated local definitions (the `thumbnailKey` and `webKey` `const` blocks, currently lines 71-81):

```js
const thumbnailKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.thumbnails', filename].join('/');
};

const webKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.web', filename].join('/');
};
```

Leave `buildPhotoUrl` and all other functions untouched.

- [ ] **Step 6: Verify the build script still parses**

Run: `node --check scripts/fetch-photos.js`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add scripts/keys.js scripts/keys.test.js scripts/fetch-photos.js
git commit -m "Extract shared thumbnail/web key helpers into keys.js"
```

---

## Task 2: Cover store + refactor set-cover CLI

**Files:**
- Create: `scripts/coversStore.js`
- Modify: `scripts/set-cover.js` (full rewrite onto the store)

- [ ] **Step 1: Create `scripts/coversStore.js`**

Mirrors `scripts/favoritesStore.js` exactly, but for `album-covers.json`:

```js
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

export const COVERS_KEY = 'album-covers.json';

export const loadCovers = async () => {
  const client = createS3Client();
  const bucketName = getBucketName();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: COVERS_KEY }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return {};
  }
};

export const saveCovers = async (covers) => {
  const client = createS3Client();
  const bucketName = getBucketName();
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: COVERS_KEY,
    Body: JSON.stringify(covers, null, 2),
    ContentType: 'application/json',
  }));
};
```

- [ ] **Step 2: Rewrite `scripts/set-cover.js` onto the store**

Replace the entire file contents with:

```js
import { loadCovers, saveCovers } from './coversStore.js';

const run = async () => {
  const [albumSlug, filename] = process.argv.slice(2);

  if (!albumSlug || !filename) {
    throw new Error('Usage: node scripts/set-cover.js <album-slug> <photo-filename>');
  }

  const covers = await loadCovers();
  const previous = covers[albumSlug];
  covers[albumSlug] = filename;
  await saveCovers(covers);

  if (previous) {
    console.log(`Cover for "${albumSlug}" updated: "${previous}" → "${filename}"`);
  } else {
    console.log(`Cover for "${albumSlug}" set to "${filename}"`);
  }
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 3: Verify both files parse**

Run: `node --check scripts/coversStore.js && node --check scripts/set-cover.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add scripts/coversStore.js scripts/set-cover.js
git commit -m "Add coversStore and refactor set-cover CLI onto it"
```

---

## Task 3: deletePhoto module

**Files:**
- Create: `scripts/deletePhoto.js`
- Test: `scripts/deletePhoto.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/deletePhoto.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumSlugFromKey, filenameFromKey, removeKey, clearCoverIfMatches } from './deletePhoto.js';

test('albumSlugFromKey returns the first path segment', () => {
  assert.equal(albumSlugFromKey('2025-italy/a.jpg'), '2025-italy');
});

test('filenameFromKey returns everything after the album slug', () => {
  assert.equal(filenameFromKey('2025-italy/a.jpg'), 'a.jpg');
  assert.equal(filenameFromKey('a-b/c/d.jpg'), 'c/d.jpg');
});

test('removeKey drops the matching key', () => {
  assert.deepEqual(removeKey(['x/a.jpg', 'y/b.jpg'], 'x/a.jpg'), ['y/b.jpg']);
});

test('removeKey leaves the list unchanged when key is absent', () => {
  assert.deepEqual(removeKey(['y/b.jpg'], 'x/a.jpg'), ['y/b.jpg']);
});

test('clearCoverIfMatches removes the album entry when the cover matches', () => {
  assert.deepEqual(clearCoverIfMatches({ a: 'x.jpg', b: 'y.jpg' }, 'a', 'x.jpg'), { b: 'y.jpg' });
});

test('clearCoverIfMatches returns the same object when the filename differs', () => {
  const covers = { a: 'x.jpg' };
  assert.equal(clearCoverIfMatches(covers, 'a', 'z.jpg'), covers);
});

test('clearCoverIfMatches returns the same object when the album is absent', () => {
  const covers = { a: 'x.jpg' };
  assert.equal(clearCoverIfMatches(covers, 'missing', 'x.jpg'), covers);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/deletePhoto.test.js`
Expected: FAIL — `Cannot find module './deletePhoto.js'`.

- [ ] **Step 3: Create `scripts/deletePhoto.js`**

```js
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';
import { thumbnailKey, webKey } from './keys.js';
import { loadFavorites, saveFavorites } from './favoritesStore.js';
import { loadCovers, saveCovers } from './coversStore.js';

// ── pure helpers ──────────────────────────────────────────────────────────────

export const albumSlugFromKey = (key) => key.split('/')[0];

export const filenameFromKey = (key) => key.split('/').slice(1).join('/');

export const removeKey = (favorites, key) => favorites.filter(k => k !== key);

export const clearCoverIfMatches = (covers, albumSlug, filename) => {
  if (covers[albumSlug] !== filename) return covers;
  const { [albumSlug]: _removed, ...rest } = covers;
  return rest;
};

// ── effect: delete the photo's R2 objects, then clean up references ─────────────

export const deletePhoto = async (key) => {
  const client = createS3Client();
  const bucketName = getBucketName();

  for (const objectKey of [key, thumbnailKey(key), webKey(key)]) {
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
  }

  const favorites = await loadFavorites();
  const cleanedFavorites = removeKey(favorites, key);
  if (cleanedFavorites.length !== favorites.length) {
    await saveFavorites(cleanedFavorites);
  }

  const covers = await loadCovers();
  const cleanedCovers = clearCoverIfMatches(covers, albumSlugFromKey(key), filenameFromKey(key));
  if (cleanedCovers !== covers) {
    await saveCovers(cleanedCovers);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/deletePhoto.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/deletePhoto.js scripts/deletePhoto.test.js
git commit -m "Add deletePhoto module with R2 delete and reference cleanup"
```

---

## Task 4: Consolidated dev API plugin

**Files:**
- Create: `scripts/devApiServer.js`
- Modify: `vite.config.js`
- Remove: `scripts/favoritesDevServer.js`

- [ ] **Step 1: Create `scripts/devApiServer.js`**

```js
import { loadFavorites, saveFavorites } from './favoritesStore.js';
import { toggleFavorite } from './favorites.js';
import { loadCovers, saveCovers } from './coversStore.js';
import { deletePhoto, albumSlugFromKey, filenameFromKey } from './deletePhoto.js';

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readKey = async (req) => {
  const body = await readBody(req);
  const { key } = JSON.parse(body || '{}');
  return key;
};

// Wrap a POST handler that needs a `key`: parses body, 400s on missing key,
// 500s on throw. `handler(key)` returns the JSON response body.
const postWithKey = (handler) => async (req, res, next) => {
  if (req.method !== 'POST') { next(); return; }
  try {
    const key = await readKey(req);
    if (!key) { sendJson(res, 400, { error: 'Missing key' }); return; }
    sendJson(res, 200, await handler(key));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
};

export const devApiPlugin = () => ({
  name: 'dev-api-server',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__state', async (req, res, next) => {
      if (req.method !== 'GET') { next(); return; }
      try {
        const [favorites, covers] = await Promise.all([loadFavorites(), loadCovers()]);
        sendJson(res, 200, { favorites, covers });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });

    server.middlewares.use('/__favorites', postWithKey(async (key) => {
      const current = await loadFavorites();
      const { favorites, action } = toggleFavorite(current, key);
      await saveFavorites(favorites);
      return { favorites, action };
    }));

    server.middlewares.use('/__cover', postWithKey(async (key) => {
      const covers = await loadCovers();
      covers[albumSlugFromKey(key)] = filenameFromKey(key);
      await saveCovers(covers);
      return { covers };
    }));

    server.middlewares.use('/__delete', postWithKey(async (key) => {
      await deletePhoto(key);
      return { deleted: key };
    }));
  },
});
```

- [ ] **Step 2: Wire the plugin in `vite.config.js`**

Replace line 3:

```js
import { favoritesDevPlugin } from './scripts/favoritesDevServer.js'
```

with:

```js
import { devApiPlugin } from './scripts/devApiServer.js'
```

Replace the plugins line (line 6):

```js
  plugins: [react(), favoritesDevPlugin()],
```

with:

```js
  plugins: [react(), devApiPlugin()],
```

- [ ] **Step 3: Remove the old favorites-only plugin**

```bash
git rm scripts/favoritesDevServer.js
```

- [ ] **Step 4: Verify the plugin parses**

Run: `node --check scripts/devApiServer.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add scripts/devApiServer.js vite.config.js
git commit -m "Consolidate dev endpoints into devApiServer (state, favorites, cover, delete)"
```

---

## Task 5: DevToolsProvider + hooks

**Files:**
- Create: `src/context/DevToolsContext.jsx`
- Modify: `src/main.jsx`
- Remove: `src/context/FavoritesContext.jsx`

- [ ] **Step 1: Create `src/context/DevToolsContext.jsx`**

```jsx
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { favoriteKeyFromUrl } from '../../scripts/favorites.js';

const STATE_ENDPOINT = '/__state';

const DevToolsContext = createContext(null);

const postKey = async (endpoint, key) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const DevToolsProvider = ({ children }) => {
  const [favorites, setFavorites] = useState(null); // null = not loaded
  const [covers, setCovers] = useState({});
  const [deleted, setDeleted] = useState(() => new Set());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch(STATE_ENDPOINT)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => {
        setFavorites(new Set(data.favorites));
        setCovers(data.covers ?? {});
      })
      .catch(err => console.warn('Dev tools unavailable:', err.message));
  }, []);

  const enabled = import.meta.env.DEV && favorites !== null;

  const run = useCallback(async (fn) => {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }, []);

  const toggleFavorite = useCallback((url) => run(async () => {
    try {
      const data = await postKey('/__favorites', favoriteKeyFromUrl(url));
      setFavorites(new Set(data.favorites));
    } catch (err) {
      console.warn('Failed to toggle favorite:', err.message);
    }
  }), [run]);

  const setCover = useCallback((url) => run(async () => {
    try {
      const data = await postKey('/__cover', favoriteKeyFromUrl(url));
      setCovers(data.covers ?? {});
    } catch (err) {
      console.warn('Failed to set cover:', err.message);
    }
  }), [run]);

  const deletePhoto = useCallback((url) => run(async () => {
    const key = favoriteKeyFromUrl(url);
    try {
      await postKey('/__delete', key);
      setDeleted(prev => new Set(prev).add(key));
    } catch (err) {
      console.warn('Failed to delete photo:', err.message);
    }
  }), [run]);

  const value = { enabled, pending, favorites, covers, deleted, toggleFavorite, setCover, deletePhoto };
  return <DevToolsContext.Provider value={value}>{children}</DevToolsContext.Provider>;
};

const useDevTools = () => useContext(DevToolsContext) ?? {};

export const useFavorites = () => {
  const { enabled, pending, favorites, toggleFavorite } = useDevTools();
  return {
    enabled: enabled ?? false,
    pending: pending ?? false,
    isFavorite: (url) => favorites?.has(favoriteKeyFromUrl(url)) ?? false,
    toggle: (url) => toggleFavorite?.(url),
  };
};

export const useCovers = () => {
  const { enabled, pending, covers, setCover } = useDevTools();
  return {
    enabled: enabled ?? false,
    pending: pending ?? false,
    isCover: (url) => {
      const key = favoriteKeyFromUrl(url);
      const albumSlug = key.split('/')[0];
      const filename = key.split('/').slice(1).join('/');
      return covers?.[albumSlug] === filename;
    },
    setCover: (url) => setCover?.(url),
  };
};

export const useDeletions = () => {
  const { enabled, pending, deleted, deletePhoto } = useDevTools();
  return {
    enabled: enabled ?? false,
    pending: pending ?? false,
    isDeleted: (url) => deleted?.has(favoriteKeyFromUrl(url)) ?? false,
    deletePhoto: (url) => deletePhoto?.(url),
  };
};
```

- [ ] **Step 2: Update `src/main.jsx`**

Replace line 5:

```jsx
import { FavoritesProvider } from './context/FavoritesContext.jsx'
```

with:

```jsx
import { DevToolsProvider } from './context/DevToolsContext.jsx'
```

Replace the `<FavoritesProvider>` wrapper (lines 9 and 11) so the render reads:

```jsx
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DevToolsProvider>
      <App />
    </DevToolsProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: Remove the old favorites context**

```bash
git rm src/context/FavoritesContext.jsx
```

- [ ] **Step 4: Verify nothing still imports the old context**

Run: `grep -rn "FavoritesContext\|FavoritesProvider" src`
Expected: no matches (exit 1 / empty output).

- [ ] **Step 5: Commit**

```bash
git add src/context/DevToolsContext.jsx src/main.jsx
git commit -m "Add DevToolsProvider consolidating favorites, covers, deletions"
```

---

## Task 6: Filter deleted photos in PhotoGrid

**Files:**
- Modify: `src/components/PhotoGrid.jsx`

- [ ] **Step 1: Update `src/components/PhotoGrid.jsx`**

Replace the full file contents with:

```jsx
import { useSearchParams } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
import { useDeletions } from '../context/DevToolsContext';
import './PhotoGrid.css';

const PhotoGrid = ({ photos }) => {
  const { isDeleted } = useDeletions();
  const visible = photos.filter(photo => !isDeleted(photo.url));

  const [searchParams, setSearchParams] = useSearchParams();
  const photoParam = searchParams.get('photo');
  const selectedIndex = photoParam !== null ? parseInt(photoParam, 10) : null;

  const openPhoto = (index) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('photo', index);
    return next;
  });

  const closePhoto = () => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.delete('photo');
    return next;
  });

  return (
    <>
      <div className="photo-grid">
        {visible.map((photo, index) => (
          <button
            key={photo.url}
            className="photo-card"
            onClick={() => openPhoto(index)}
          >
            <img src={photo.thumbnail} alt={photo.filename} loading="lazy" />
          </button>
        ))}
      </div>
      {selectedIndex !== null && selectedIndex < visible.length && (
        <PhotoViewer
          photos={visible}
          currentIndex={selectedIndex}
          onClose={closePhoto}
          onNavigate={openPhoto}
        />
      )}
    </>
  );
};

export default PhotoGrid;
```

Note: the `selectedIndex < visible.length` guard prevents an out-of-range render if the last visible photo is deleted while open.

- [ ] **Step 2: Verify it builds**

Run: `npm run build:site`
Expected: build succeeds (exit 0). (No `build:photos` needed; it uses the committed `src/data/photos.json`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/PhotoGrid.jsx
git commit -m "Filter deleted photos out of PhotoGrid"
```

---

## Task 7: Cover + delete buttons in PhotoViewer

**Files:**
- Modify: `src/components/PhotoViewer.jsx`
- Modify: `src/components/PhotoViewer.css`

- [ ] **Step 1: Add the new icon components in `PhotoViewer.jsx`**

After the existing `CloseIcon` component (ends at the line before `const ExifStrip`), add:

```jsx
const CoverIcon = ({ active }) => (
  <svg
    className="viewer-action-icon"
    viewBox="0 0 24 24"
    fill={active ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

const TrashIcon = () => (
  <svg
    className="viewer-action-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
```

- [ ] **Step 2: Update the imports and hook usage in `PhotoViewer.jsx`**

Replace the import line:

```jsx
import { useFavorites } from '../context/FavoritesContext';
```

with:

```jsx
import { useFavorites, useCovers, useDeletions } from '../context/DevToolsContext';
```

- [ ] **Step 3: Restructure the component body to add cover/delete state and a delete handler**

Replace the component body from the line `const currentPhoto = photos[currentIndex];` down through the `useEffect(...)` block (i.e. everything before the `const handleBackdropClick` line) with:

```jsx
  const { enabled, isFavorite, toggle, pending } = useFavorites();
  const { isCover, setCover, pending: coverPending } = useCovers();
  const { deletePhoto, pending: deletePending } = useDeletions();

  const currentPhoto = photos[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === photos.length - 1;

  const goToPrevious = () => {
    if (!isFirst) {
      onNavigate(currentIndex - 1);
    }
  };

  const goToNext = () => {
    if (!isLast) {
      onNavigate(currentIndex + 1);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowLeft') {
      goToPrevious();
    } else if (e.key === 'ArrowRight') {
      goToNext();
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!currentPhoto) return null;

  const favorited = isFavorite(currentPhoto.url);
  const photoIsCover = isCover(currentPhoto.url);

  const handleDelete = () => {
    const ok = window.confirm(`Delete "${currentPhoto.filename}"? This permanently removes it from R2.`);
    if (!ok) return;
    if (isLast) onClose();
    deletePhoto(currentPhoto.url);
  };
```

Note: the previous `favorited`/`isFirst`/`isLast` declarations that lived above the handlers are now folded into this block — make sure they are not duplicated later in the file.

- [ ] **Step 4: Add the cover + delete buttons in the `.viewer-info` block**

In the JSX, find the existing favorite button block:

```jsx
            {enabled && (
              <button
                className={`viewer-favorite${favorited ? ' is-favorite' : ''}`}
                onClick={() => toggle(currentPhoto.url)}
                disabled={pending}
                aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
              >
                <HeartIcon filled={favorited} />
              </button>
            )}
```

Immediately after it (still inside `.viewer-info`), add:

```jsx
            {enabled && (
              <button
                className={`viewer-action${photoIsCover ? ' is-cover' : ''}`}
                onClick={() => setCover(currentPhoto.url)}
                disabled={coverPending || photoIsCover}
                aria-label={photoIsCover ? 'Current album cover' : 'Set as album cover'}
              >
                <CoverIcon active={photoIsCover} />
              </button>
            )}
            {enabled && (
              <button
                className="viewer-action viewer-delete"
                onClick={handleDelete}
                disabled={deletePending}
                aria-label="Delete photo"
              >
                <TrashIcon />
              </button>
            )}
```

- [ ] **Step 5: Add styles in `src/components/PhotoViewer.css`**

Change the existing `.viewer-favorite` base rules so they are shared with `.viewer-action`. Replace this block (currently lines 187-209):

```css
.viewer-favorite {
  display: flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  transition: color 0.2s;
}

.viewer-favorite:hover:not(:disabled) {
  color: #e0e0e0;
}

.viewer-favorite.is-favorite {
  color: #e0552e;
}

.viewer-favorite:disabled {
  cursor: default;
  opacity: 0.6;
}
```

with:

```css
.viewer-favorite,
.viewer-action {
  display: flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  transition: color 0.2s;
}

.viewer-favorite:hover:not(:disabled),
.viewer-action:hover:not(:disabled) {
  color: #e0e0e0;
}

.viewer-favorite.is-favorite {
  color: #e0552e;
}

.viewer-action.is-cover {
  color: #4a9eff;
}

.viewer-delete:hover:not(:disabled) {
  color: #e0552e;
}

.viewer-favorite:disabled,
.viewer-action:disabled {
  cursor: default;
  opacity: 0.6;
}

.viewer-action-icon {
  width: 1.1rem;
  height: 1.1rem;
}
```

- [ ] **Step 6: Verify it builds**

Run: `npm run build:site`
Expected: build succeeds (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/components/PhotoViewer.jsx src/components/PhotoViewer.css
git commit -m "Add dev-only cover and delete controls to PhotoViewer"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit-test suite**

Run: `npm test`
Expected: all tests pass, including `keys.test.js`, `deletePhoto.test.js`, and the existing `favorites.test.js`.

- [ ] **Step 2: Production build sanity check**

Run: `npm run build:site`
Expected: build succeeds. (Dev controls are gated by `import.meta.env.DEV`, so they must not appear in the production bundle.)

- [ ] **Step 3: Manual dev smoke test (requires `.env` with R2 credentials)**

Run: `npm run dev`, then in the browser:
1. Open an album → open a photo. Confirm the cover (image) and delete (trash) buttons appear next to the heart.
2. Click **set as cover**; confirm the button shows the active blue state and the network call to `/__cover` returns 200.
3. Click **delete**, accept the confirm dialog; confirm the photo disappears from the grid immediately and `/__delete` returns 200.
4. Reload; confirm the deleted photo stays gone after a fresh `/__state` load is not expected (photos.json is static) — instead verify in R2 (or via `npm run r2 ls <album>/`) that the original, `.thumbnails/`, and `.web/` objects are gone.

Expected: all steps behave as described; no console errors.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "Verify dev-server photo admin end to end"
```
(Skip if there is nothing to commit.)

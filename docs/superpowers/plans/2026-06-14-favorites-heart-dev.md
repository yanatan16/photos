# Dev-only Favorites Heart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a heart button in the photo viewer (dev server only) that toggles a photo's favorite in R2 by clicking, equivalent to running `npm run favorite`.

**Architecture:** A Vite dev-server middleware (`apply: 'serve'`) exposes `GET/POST /__favorites` backed by a shared R2 store module that the CLI also uses. A React context fetches the current favorites once in dev and exposes `isFavorite`/`toggle`; the viewer renders a heart only when enabled. The favorite key is derived from `photo.url` so it works in any view.

**Tech Stack:** Node ESM, `node:test`, AWS SDK S3 (R2), Vite 6 plugin API (Connect middleware), React 18 context, react-router-dom v6.

**Note on testing:** Only the pure helper `favoriteKeyFromUrl` (Task 1) has automated tests. The R2 store, Vite middleware, and React UI are network/dev-server/UI I/O with no harness in this repo — they use `node --check` + `npm run build:site` (compile) checks, and live R2/browser verification is done manually by the controller/user (a POST writes to the real R2 bucket).

---

### Task 1: Shared R2 store + key-from-URL helper

**Files:**
- Modify: `scripts/favorites.js` (add `favoriteKeyFromUrl`)
- Modify: `scripts/favorites.test.js` (add tests)
- Create: `scripts/favoritesStore.js`
- Modify: `scripts/favorite.js` (use the store)

- [ ] **Step 1: Add failing tests for `favoriteKeyFromUrl`**

In `scripts/favorites.test.js`, update the import line to include `favoriteKeyFromUrl`:

```js
import { favoriteKey, favoriteKeyFromUrl, toggleFavorite, buildFavorites } from './favorites.js';
```

And append these tests at the end of the file:

```js
test('favoriteKeyFromUrl strips origin and leading slash', () => {
  assert.equal(
    favoriteKeyFromUrl('https://pub-abc.r2.dev/2026-boulder-winter/DSC01652.jpg'),
    '2026-boulder-winter/DSC01652.jpg'
  );
});

test('favoriteKeyFromUrl handles nested paths', () => {
  assert.equal(favoriteKeyFromUrl('https://x.example/a-b/c/d.jpg'), 'a-b/c/d.jpg');
});
```

- [ ] **Step 2: Run tests, verify the new ones FAIL**

Run: `node --test scripts/favorites.test.js`
Expected: FAIL — `favoriteKeyFromUrl is not a function` (or import error) for the two new tests; the existing 5 still pass.

- [ ] **Step 3: Implement `favoriteKeyFromUrl`**

In `scripts/favorites.js`, add this export (e.g. directly after the existing `favoriteKey` export):

```js
export const favoriteKeyFromUrl = (url) => new URL(url).pathname.replace(/^\/+/, '');
```

- [ ] **Step 4: Run tests, verify ALL pass**

Run: `node --test scripts/favorites.test.js`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Create `scripts/favoritesStore.js`**

```js
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

export const FAVORITES_KEY = 'favorites.json';

export const loadFavorites = async () => {
  const client = createS3Client();
  const bucketName = getBucketName();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: FAVORITES_KEY }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return [];
  }
};

export const saveFavorites = async (favorites) => {
  const client = createS3Client();
  const bucketName = getBucketName();
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: FAVORITES_KEY,
    Body: JSON.stringify(favorites, null, 2),
    ContentType: 'application/json',
  }));
};
```

Note: `createS3Client()`/`getBucketName()` are called BEFORE the try block intentionally — missing R2 credentials should throw (surface the problem), not be swallowed into an empty list. Only an actual GET miss returns `[]`.

- [ ] **Step 6: Refactor `scripts/favorite.js` to use the store**

Replace the ENTIRE contents of `scripts/favorite.js` with:

```js
import { loadFavorites, saveFavorites } from './favoritesStore.js';
import { toggleFavorite, favoriteKey } from './favorites.js';

const run = async () => {
  const [albumSlug, filename] = process.argv.slice(2);

  if (!albumSlug || !filename) {
    throw new Error('Usage: npm run favorite -- <album-slug> <photo-filename>');
  }

  const current = await loadFavorites();
  const key = favoriteKey(albumSlug, filename);
  const { favorites, action } = toggleFavorite(current, key);
  await saveFavorites(favorites);

  console.log(action === 'added'
    ? `Added ${key} to favorites`
    : `Removed ${key} from favorites`);
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 7: Verify syntax + usage path + full test suite**

Run: `node --check scripts/favoritesStore.js && node --check scripts/favorite.js`
Expected: no output, exit 0.

Run: `npm run favorite`
Expected: prints `Error: Usage: npm run favorite -- <album-slug> <photo-filename>` and exits non-zero (this path does not touch R2).

Run: `node --test scripts/favorites.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 8: Commit**

```bash
git add scripts/favorites.js scripts/favorites.test.js scripts/favoritesStore.js scripts/favorite.js
git commit -m "Extract R2 favorites store; add favoriteKeyFromUrl helper"
```

---

### Task 2: Vite dev-server middleware

**Files:**
- Create: `scripts/favoritesDevServer.js`
- Modify: `vite.config.js`

- [ ] **Step 1: Create `scripts/favoritesDevServer.js`**

```js
import { loadFavorites, saveFavorites } from './favoritesStore.js';
import { toggleFavorite } from './favorites.js';

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

export const favoritesDevPlugin = () => ({
  name: 'favorites-dev-server',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__favorites', async (req, res, next) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { favorites: await loadFavorites() });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const { key } = JSON.parse(body || '{}');
          if (!key) {
            sendJson(res, 400, { error: 'Missing key' });
            return;
          }
          const current = await loadFavorites();
          const { favorites, action } = toggleFavorite(current, key);
          await saveFavorites(favorites);
          sendJson(res, 200, { favorites, action });
          return;
        }
        next();
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
  },
});
```

- [ ] **Step 2: Register the plugin in `vite.config.js`**

Current file:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/photos/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
})
```

Change the imports and the `plugins` line to:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { favoritesDevPlugin } from './scripts/favoritesDevServer.js'
```

```js
  plugins: [react(), favoritesDevPlugin()],
```

(Leave everything else unchanged.)

- [ ] **Step 3: Verify syntax + production build excludes the serve-only plugin**

Run: `node --check scripts/favoritesDevServer.js`
Expected: no output, exit 0.

Run: `npm run build:site`
Expected: Vite build succeeds, exit 0 (the `apply: 'serve'` plugin is inactive during build; config loads without error).

NOTE: Do NOT live-test the endpoint here. A GET requires R2 credentials and a POST WRITES to the real R2 bucket — live verification is handled by the controller/user.

- [ ] **Step 4: Commit**

```bash
git add scripts/favoritesDevServer.js vite.config.js
git commit -m "Add dev-server middleware for toggling favorites in R2"
```

---

### Task 3: Favorites context provider

**Files:**
- Create: `src/context/FavoritesContext.jsx`
- Modify: `src/main.jsx`

- [ ] **Step 1: Create `src/context/FavoritesContext.jsx`**

```jsx
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { favoriteKeyFromUrl } from '../../scripts/favorites.js';

const ENDPOINT = '/__favorites';

const FavoritesContext = createContext({
  enabled: false,
  isFavorite: () => false,
  toggle: () => {},
  pending: false,
});

export const FavoritesProvider = ({ children }) => {
  const [keys, setKeys] = useState(null); // null = not loaded; Set = loaded
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch(ENDPOINT)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => setKeys(new Set(data.favorites)))
      .catch(err => console.warn('Favorites unavailable:', err.message));
  }, []);

  const enabled = import.meta.env.DEV && keys !== null;

  const isFavorite = useCallback(
    (url) => keys?.has(favoriteKeyFromUrl(url)) ?? false,
    [keys]
  );

  const toggle = useCallback(async (url) => {
    setPending(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: favoriteKeyFromUrl(url) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(new Set(data.favorites));
    } catch (err) {
      console.warn('Failed to toggle favorite:', err.message);
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <FavoritesContext.Provider value={{ enabled, isFavorite, toggle, pending }}>
      {children}
    </FavoritesContext.Provider>
  );
};

export const useFavorites = () => useContext(FavoritesContext);
```

Note: the import `../../scripts/favorites.js` resolves from `src/context/` to the repo-root `scripts/favorites.js` — reusing the same pure key helper as the backend (DRY). `favoriteKeyFromUrl` uses the `URL` global, which exists in the browser.

- [ ] **Step 2: Wrap `<App>` with the provider in `src/main.jsx`**

Replace the entire contents of `src/main.jsx` with:

```jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { FavoritesProvider } from './context/FavoritesContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <FavoritesProvider>
      <App />
    </FavoritesProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: Verify the app compiles**

Run: `npm run build:site`
Expected: Vite build succeeds, exit 0. (In a production build `import.meta.env.DEV` is false, so the provider never fetches — `enabled` is always false.)

- [ ] **Step 4: Commit**

```bash
git add src/context/FavoritesContext.jsx src/main.jsx
git commit -m "Add dev favorites context provider"
```

---

### Task 4: Heart button in the photo viewer

**Files:**
- Modify: `src/components/PhotoViewer.jsx`
- Modify: `src/components/PhotoViewer.css`

- [ ] **Step 1: Import the hook in `PhotoViewer.jsx`**

At the top of `src/components/PhotoViewer.jsx`, after the existing imports, add:

```jsx
import { useFavorites } from '../context/FavoritesContext';
```

- [ ] **Step 2: Add a `HeartIcon` component**

In `src/components/PhotoViewer.jsx`, next to the existing `ChevronIcon` component definition, add:

```jsx
const HeartIcon = ({ filled }) => (
  <svg
    className="viewer-favorite-icon"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
);
```

- [ ] **Step 3: Read the favorites context inside `PhotoViewer`**

In the `PhotoViewer` component body (the existing function component that destructures `{ photos, currentIndex, onClose, onNavigate }`), add this line near the top of the body, after `const currentPhoto = photos[currentIndex];`:

```jsx
  const { enabled, isFavorite, toggle, pending } = useFavorites();
```

- [ ] **Step 4: Render the heart in the info row**

In the JSX, the info row currently ends with the download link:

```jsx
            <a
              href={currentPhoto.url}
              download={currentPhoto.filename}
              className="viewer-download"
              aria-label="Download original"
            >
              ↓
            </a>
          </div>
```

Insert the heart button immediately AFTER the `</a>` and BEFORE the `</div>`:

```jsx
            <a
              href={currentPhoto.url}
              download={currentPhoto.filename}
              className="viewer-download"
              aria-label="Download original"
            >
              ↓
            </a>
            {enabled && (
              <button
                className={`viewer-favorite${isFavorite(currentPhoto.url) ? ' is-favorite' : ''}`}
                onClick={() => toggle(currentPhoto.url)}
                disabled={pending}
                aria-label={isFavorite(currentPhoto.url) ? 'Remove from favorites' : 'Add to favorites'}
              >
                <HeartIcon filled={isFavorite(currentPhoto.url)} />
              </button>
            )}
          </div>
```

- [ ] **Step 5: Add styles to `PhotoViewer.css`**

Append to `src/components/PhotoViewer.css`:

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

.viewer-favorite-icon {
  width: 1.1rem;
  height: 1.1rem;
}
```

- [ ] **Step 6: Verify the app compiles**

Run: `npm run build:site`
Expected: Vite build succeeds, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/PhotoViewer.jsx src/components/PhotoViewer.css
git commit -m "Add dev-only favorite heart toggle in photo viewer"
```

---

## Manual end-to-end verification (controller/user, after all tasks)

Requires `.env` with R2 credentials. Writes to the real R2 `favorites.json`.

1. `npm run dev`, open a photo in the viewer.
2. The heart appears in the info row next to ↓. Click it → icon fills; `favorites.json` in R2 gains the key.
3. Run `npm run favorite -- <same-album> <same-file>` → it reports `Removed ...` (confirming both paths share one source of truth), then run it again to re-add.
4. Reload the page → the heart shows filled (live GET reflects R2).
5. Click the heart again → icon empties; R2 updates.
6. `npm run build:site && npm run preview` → confirm NO `/__favorites` request is made and the heart is absent (production has no write path).

## Done criteria

- In `npm run dev`, clicking the heart toggles the photo in R2 `favorites.json`, equivalent to `npm run favorite`.
- The heart reflects live favorite state on open and after toggles.
- The CLI still works (refactored onto the shared store).
- A production build shows no heart and makes no `/__favorites` calls.

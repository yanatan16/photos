import { loadFavorites, saveFavorites } from './favoritesStore.js';
import { toggleFavorite, albumSlugFromKey, filenameFromKey } from './favorites.js';
import { loadCovers, saveCovers } from './coversStore.js';
import { deletePhoto } from './deletePhoto.js';

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

const parseJson = (body) => {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
};

const readKey = async (req) => {
  const { key } = parseJson(await readBody(req));
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

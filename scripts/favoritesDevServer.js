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

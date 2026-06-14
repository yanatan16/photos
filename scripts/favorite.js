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

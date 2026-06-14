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

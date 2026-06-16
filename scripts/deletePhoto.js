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

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

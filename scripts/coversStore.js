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

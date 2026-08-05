import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

export const createJsonStore = (key, fallback) => ({
  load: async () => {
    const client = createS3Client();
    const bucketName = getBucketName();
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
      return JSON.parse(await response.Body.transformToString());
    } catch {
      return fallback;
    }
  },
  save: async (data) => {
    const client = createS3Client();
    const bucketName = getBucketName();
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json',
    }));
  },
});

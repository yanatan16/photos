import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

const formatDate = (date) =>
  date.toISOString().slice(0, 10);

const listObjects = async (client, bucketName, prefix) => {
  const objects = [];
  let continuationToken;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }));
    if (response.Contents) objects.push(...response.Contents);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
};

const run = async () => {
  const prefix = process.argv[2] || '';
  const client = createS3Client();
  const bucketName = getBucketName();

  const objects = await listObjects(client, bucketName, prefix);

  if (objects.length === 0) {
    console.log('(no objects found)');
    return;
  }

  const dateWidth = 10;
  const sizeWidth = 9;

  for (const obj of objects) {
    const date = formatDate(obj.LastModified).padEnd(dateWidth);
    const size = formatSize(obj.Size).padStart(sizeWidth);
    console.log(`${date}  ${size}  ${obj.Key}`);
  }

  console.log(`\n${objects.length} object${objects.length !== 1 ? 's' : ''}`);
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

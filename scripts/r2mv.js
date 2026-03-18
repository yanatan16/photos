import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

const listPrefix = async (client, bucketName, prefix) => {
  const objects = [];
  let continuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    if (response.Contents) objects.push(...response.Contents);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
};

const moveOne = async (client, bucketName, src, dest) => {
  await client.send(new CopyObjectCommand({
    Bucket: bucketName,
    CopySource: `${bucketName}/${src}`,
    Key: dest,
  }));
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: src }));
};

const run = async () => {
  const [src, dest] = process.argv.slice(2);

  if (!src || !dest) {
    throw new Error('Usage: node scripts/r2mv.js <source> <dest>');
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  const albumObjects = await listPrefix(client, bucketName, `${src}/`);

  if (albumObjects.length > 0) {
    console.log(`Renaming album "${src}" → "${dest}" (${albumObjects.length} objects)`);
    for (const obj of albumObjects) {
      const destKey = dest + obj.Key.slice(src.length);
      process.stdout.write(`  ${obj.Key} → ${destKey} ... `);
      await moveOne(client, bucketName, obj.Key, destKey);
      console.log('done');
    }
  } else {
    console.log(`${src} → ${dest}`);
    await moveOne(client, bucketName, src, dest);
  }

  console.log('Done.');
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

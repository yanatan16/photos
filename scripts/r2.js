import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const listPrefix = async (client, bucketName, prefix) => {
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

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

// ── subcommands ───────────────────────────────────────────────────────────────

const ls = async (client, bucketName, [prefix = '']) => {
  const objects = await listPrefix(client, bucketName, prefix);

  if (objects.length === 0) {
    console.log('(no objects found)');
    return;
  }

  for (const obj of objects) {
    const date = obj.LastModified.toISOString().slice(0, 10).padEnd(10);
    const size = formatSize(obj.Size).padStart(9);
    console.log(`${date}  ${size}  ${obj.Key}`);
  }
  console.log(`\n${objects.length} object${objects.length !== 1 ? 's' : ''}`);
};

const mv = async (client, bucketName, [src, dest]) => {
  if (!src || !dest) throw new Error('Usage: r2 mv <source> <dest>');

  const moveOne = async (srcKey, destKey) => {
    await client.send(new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${srcKey}`,
      Key: destKey,
    }));
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: srcKey }));
  };

  const albumObjects = await listPrefix(client, bucketName, `${src}/`);

  if (albumObjects.length > 0) {
    console.log(`Renaming album "${src}" → "${dest}" (${albumObjects.length} objects)`);
    for (const obj of albumObjects) {
      const destKey = dest + obj.Key.slice(src.length);
      process.stdout.write(`  ${obj.Key} → ${destKey} ... `);
      await moveOne(obj.Key, destKey);
      console.log('done');
    }
  } else {
    console.log(`${src} → ${dest}`);
    await moveOne(src, dest);
  }
};

const rm = async (client, bucketName, [key]) => {
  if (!key) throw new Error('Usage: r2 rm <key>');

  const albumObjects = await listPrefix(client, bucketName, `${key}/`);

  if (albumObjects.length > 0) {
    console.log(`Removing album "${key}" (${albumObjects.length} objects)`);
    for (const obj of albumObjects) {
      process.stdout.write(`  ${obj.Key} ... `);
      await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key }));
      console.log('done');
    }
  } else {
    console.log(`Removing ${key}`);
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  }
};

// ── dispatch ──────────────────────────────────────────────────────────────────

const COMMANDS = { ls, mv, rm };

const run = async () => {
  const [subcommand, ...args] = process.argv.slice(2);
  const handler = COMMANDS[subcommand];

  if (!handler) {
    const names = Object.keys(COMMANDS).join(' | ');
    throw new Error(`Usage: r2 <${names}> [args]\n\n  r2 ls [prefix]\n  r2 mv <source> <dest>\n  r2 rm <key>`);
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  await handler(client, bucketName, args);
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

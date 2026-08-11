import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';
import { formatBytes } from './format.js';
import { createPendingQueue, pendingEntriesUnder } from './pendingOriginals.js';
import { listAllObjects } from './r2list.js';

// ── subcommands ───────────────────────────────────────────────────────────────

const ls = async (client, bucketName, [prefix = '']) => {
  const objects = await listAllObjects(client, bucketName, prefix);

  if (objects.length === 0) {
    console.log('(no objects found)');
    return;
  }

  for (const obj of objects) {
    const date = obj.LastModified.toISOString().slice(0, 10).padEnd(10);
    const size = formatBytes(obj.Size).padStart(9);
    console.log(`${date}  ${size}  ${obj.Key}`);
  }
  console.log(`\n${objects.length} object${objects.length !== 1 ? 's' : ''}`);
};

// The pending-originals queue is keyed by the original's R2 key, which mv/rm
// can change or remove underneath it. Remapping the queue is out of scope —
// this only surfaces a warning so a human can re-check the manifest before
// draining it and writing an original back under a now-stale key.
const warnIfPending = (key, verb) => {
  const stale = pendingEntriesUnder(createPendingQueue().load(), key);
  if (stale.length === 0) return;

  console.warn(`\nWarning: ${stale.length} pending original(s) still reference "${key}" after this ${verb}:`);
  for (const entry of stale) console.warn(`  ${entry.key}`);
  console.warn('Re-check .pending-originals.json before running `npm run upload:originals`.');
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

  const albumObjects = await listAllObjects(client, bucketName, `${src}/`);

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

  warnIfPending(src, 'mv');
};

const rm = async (client, bucketName, [key]) => {
  if (!key) throw new Error('Usage: r2 rm <key>');

  const albumObjects = await listAllObjects(client, bucketName, `${key}/`);

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

  warnIfPending(key, 'rm');
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

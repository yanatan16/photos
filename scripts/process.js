import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';
import { listAllObjects } from './r2list.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';
import { thumbnailKey, webKey, logicalPhotoKeys } from './keys.js';
import { makeThumbnail, makeWebSized } from './derivatives.js';
import { parseExif } from './exif.js';
import { loadExifCache, saveExifCache } from './exifStore.js';

// ── constants ─────────────────────────────────────────────────────────────────

const EXIF_FETCH_BYTES = 131072; // 128KB — enough for EXIF in any JPEG
const EXIF_CONCURRENCY = 8;
const IMAGE_CONCURRENCY = 4;

// ── helpers ───────────────────────────────────────────────────────────────────

const downloadObject = async (client, bucketName, key) => {
  const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const uploadObject = (client, bucketName, key, body) =>
  client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: 'image/jpeg' }));

// ── EXIF extraction ───────────────────────────────────────────────────────────

const fetchExifChunk = async (publicUrl, key) => {
  const response = await fetch(`${publicUrl}/${key}`, {
    headers: { Range: `bytes=0-${EXIF_FETCH_BYTES - 1}` },
  });
  if (!response.ok) throw new Error(`EXIF fetch failed with ${response.status} for ${key}`);
  return Buffer.from(await response.arrayBuffer());
};

const processExif = async (photoKeys, publicUrl, force, concurrency, exifSourceKey) => {
  console.log('\n── EXIF extraction ──────────────────────────────────────────');
  const cache = force ? {} : await loadExifCache();
  const toProcess = photoKeys.filter(key => cache[key] === undefined);

  if (force) console.log(`--force: reprocessing all ${photoKeys.length} photos`);
  else console.log(`Cache: ${Object.keys(cache).length} entries, ${toProcess.length} to process`);

  if (toProcess.length === 0) {
    console.log('All photos cached, nothing to do.');
    return;
  }

  // saveExifCache serializes the whole cache object, so two overlapping saves
  // can land out of order and drop entries. Chain them so only one is ever in
  // flight.
  let pendingSave = Promise.resolve();
  const queueSave = () => {
    pendingSave = pendingSave.then(() => withRetry(() => saveExifCache(cache)));
  };

  const items = toProcess.map(key => ({ id: key, name: key, totalBytes: null }));
  const display = createProgressDisplay({
    label: `Extracting EXIF from ${items.length} photo(s)`,
    items,
  });

  let done = 0;
  let results;

  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      try {
        const buffer = await withRetry(() => fetchExifChunk(publicUrl, exifSourceKey(item.id)), {
          onRetry: ({ attempt, attempts }) =>
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`),
        });
        cache[item.id] = await parseExif(buffer);
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
      done += 1;
      if (done % 10 === 0) queueSave();
      return cache[item.id];
    });
  } finally {
    display.stop();
    await pendingSave;
    await withRetry(() => saveExifCache(cache));
  }

  const failures = results.filter(result => result.error);
  console.log(`Saved cache (${Object.keys(cache).length} entries). Processed ${done} new photos.`);

  if (failures.length > 0) {
    console.error(`${failures.length} photo(s) failed EXIF extraction:`);
    for (const failure of failures) console.error(`  ${failure.item.id}: ${failure.error.message}`);
  }
};

// ── image resizing ────────────────────────────────────────────────────────────

const processImages = async (client, bucketName, photoKeys, objects, concurrency) => {
  console.log('\n── Image processing ─────────────────────────────────────────');

  const presentKeys = new Set(objects.map(o => o.Key));
  const sizeByKey = new Map(objects.map(o => [o.Key, o.Size]));

  // Only photos whose original is actually in the bucket can be processed here —
  // this phase downloads the original to resize it. A photo whose original is
  // still queued locally already arrived with both derivatives, so it has
  // nothing to do; including it would just fail with NoSuchKey every run.
  const photosNeedingWork = photoKeys.filter(key =>
    presentKeys.has(key) &&
    (!presentKeys.has(thumbnailKey(key)) || !presentKeys.has(webKey(key)))
  );

  if (photosNeedingWork.length === 0) {
    console.log('All thumbnails and web-sized photos up to date.');
    return;
  }

  const items = photosNeedingWork.map(key => ({
    id: key,
    name: key,
    totalBytes: sizeByKey.get(key) ?? null,
  }));

  const display = createProgressDisplay({
    label: `Processing ${items.length} photo(s)`,
    items,
  });

  let results;

  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      const onRetry = ({ attempt, attempts }) =>
        display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);

      try {
        const original = await withRetry(
          () => downloadObject(client, bucketName, item.id),
          { onRetry },
        );
        display.updateTask(item.id, item.totalBytes ?? 0);

        const needsThumbnail = !presentKeys.has(thumbnailKey(item.id));
        const needsWeb = !presentKeys.has(webKey(item.id));

        display.noteTask(item.id, 'resizing');
        const [thumbnail, web] = await Promise.all([
          needsThumbnail ? makeThumbnail(original) : null,
          needsWeb ? makeWebSized(original) : null,
        ]);

        display.noteTask(item.id, 'uploading');
        await Promise.all([
          thumbnail && withRetry(
            () => uploadObject(client, bucketName, thumbnailKey(item.id), thumbnail),
            { onRetry },
          ),
          web && withRetry(
            () => uploadObject(client, bucketName, webKey(item.id), web),
            { onRetry },
          ),
        ].filter(Boolean));
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`${results.length - failures.length}/${results.length} photo(s) processed.`);

  if (failures.length > 0) {
    console.error(`${failures.length} photo(s) failed:`);
    for (const failure of failures) console.error(`  ${failure.item.id}: ${failure.error.message}`);
    process.exitCode = 1;
  }
};

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const { concurrency } = parseConcurrencyFlag(args.filter(arg => arg !== '--force'));

  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) throw new Error('Missing R2_PUBLIC_URL in environment variables');

  const client = createS3Client();
  const bucketName = getBucketName();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);
  const presentKeys = new Set(objects.map(o => o.Key));
  const photoKeys = [...logicalPhotoKeys(objects.map(o => o.Key))].sort();
  console.log(`Found ${photoKeys.length} photos`);

  // The original is the richer source, so prefer it. When it is still queued
  // locally, the web derivative carries the EXIF that keepMetadata() kept.
  const exifSourceKey = (key) => (presentKeys.has(key) ? key : webKey(key));

  await processExif(
    photoKeys, publicUrl, force,
    concurrency ?? EXIF_CONCURRENCY, exifSourceKey,
  );
  await processImages(client, bucketName, photoKeys, objects, concurrency ?? IMAGE_CONCURRENCY);

  console.log('\nAll done!');
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

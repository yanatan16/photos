import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import exifr from 'exifr';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';

// ── constants ─────────────────────────────────────────────────────────────────

const THUMBNAIL_DIR = '.thumbnails';
const THUMBNAIL_WIDTH = 600;
const WEB_DIR = '.web';
const WEB_WIDTH = 2048;
const EXIF_CACHE_KEY = 'exif-cache.json';
const EXIF_FETCH_BYTES = 131072; // 128KB — enough for EXIF in any JPEG
const EXIF_CONCURRENCY = 8;
const IMAGE_CONCURRENCY = 4;

// ── helpers ───────────────────────────────────────────────────────────────────

const isPhoto = (key) => {
  if (!key.includes('/')) return false;
  if (key.includes(`/${THUMBNAIL_DIR}/`) || key.includes(`/${WEB_DIR}/`)) return false;
  const filename = key.split('/').pop();
  return !filename.startsWith('.') && /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?)$/i.test(filename);
};

const derivedKey = (dir) => (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, dir, filename].join('/');
};

const thumbnailKey = derivedKey(THUMBNAIL_DIR);
const webKey = derivedKey(WEB_DIR);

const listAllObjects = async (client, bucketName) => {
  const objects = [];
  let continuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    }));
    if (response.Contents) objects.push(...response.Contents);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
};

const downloadObject = async (client, bucketName, key) => {
  const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const uploadObject = (client, bucketName, key, body) =>
  client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: 'image/jpeg' }));

const loadJson = async (client, bucketName, key) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return {};
  }
};

const saveJson = (client, bucketName, key, data) =>
  client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  }));

// ── EXIF extraction ───────────────────────────────────────────────────────────

const fetchExifChunk = async (publicUrl, key) => {
  const response = await fetch(`${publicUrl}/${key}`, {
    headers: { Range: `bytes=0-${EXIF_FETCH_BYTES - 1}` },
  });
  return Buffer.from(await response.arrayBuffer());
};

const parseExif = async (buffer) => {
  try {
    const data = await exifr.parse(buffer, {
      pick: ['Make', 'Model', 'LensModel', 'Lens', 'LensID',
             'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'DateTimeOriginal'],
    });
    if (!data) return {};

    return {
      camera: [data.Make, data.Model].filter(Boolean).join(' ').trim() || null,
      lens: data.LensModel || data.Lens || data.LensID || null,
      aperture: data.FNumber ? `f/${data.FNumber}` : null,
      shutter: data.ExposureTime
        ? (data.ExposureTime < 1 ? `1/${Math.round(1 / data.ExposureTime)}s` : `${data.ExposureTime}s`)
        : null,
      iso: data.ISO ? `ISO ${data.ISO}` : null,
      focalLength: data.FocalLength ? `${Math.round(data.FocalLength)}mm` : null,
      dateTaken: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toISOString() : null,
    };
  } catch {
    return {};
  }
};

const processExif = async (client, bucketName, photoKeys, publicUrl, force, concurrency) => {
  console.log('\n── EXIF extraction ──────────────────────────────────────────');
  const cache = force ? {} : await loadJson(client, bucketName, EXIF_CACHE_KEY);
  const toProcess = photoKeys.filter(key => cache[key] === undefined);

  if (force) console.log(`--force: reprocessing all ${photoKeys.length} photos`);
  else console.log(`Cache: ${Object.keys(cache).length} entries, ${toProcess.length} to process`);

  if (toProcess.length === 0) {
    console.log('All photos cached, nothing to do.');
    return;
  }

  // saveJson serializes the whole cache object, so two overlapping saves can
  // land out of order and drop entries. Chain them so only one is ever in flight.
  let pendingSave = Promise.resolve();
  const queueSave = () => {
    pendingSave = pendingSave.then(() =>
      withRetry(() => saveJson(client, bucketName, EXIF_CACHE_KEY, cache)));
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
        const buffer = await withRetry(() => fetchExifChunk(publicUrl, item.id), {
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
    await withRetry(() => saveJson(client, bucketName, EXIF_CACHE_KEY, cache));
  }

  const failures = results.filter(result => result.error);
  console.log(`Saved cache (${Object.keys(cache).length} entries). Processed ${done} new photos.`);

  if (failures.length > 0) {
    console.error(`${failures.length} photo(s) failed EXIF extraction:`);
    for (const failure of failures) console.error(`  ${failure.item.id}: ${failure.error.message}`);
  }
};

// ── image resizing ────────────────────────────────────────────────────────────

const resizeTo = (width, quality) => (buffer) =>
  sharp(buffer)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();

const makeThumbnail = resizeTo(THUMBNAIL_WIDTH, 80);
const makeWebSized = resizeTo(WEB_WIDTH, 85);

const processImages = async (client, bucketName, photoKeys, objects, concurrency) => {
  console.log('\n── Image processing ─────────────────────────────────────────');

  const existingThumbnails = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${THUMBNAIL_DIR}/`)));
  const existingWebPhotos = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${WEB_DIR}/`)));
  const sizeByKey = new Map(objects.map(o => [o.Key, o.Size]));

  const photosNeedingWork = photoKeys.filter(key =>
    !existingThumbnails.has(thumbnailKey(key)) || !existingWebPhotos.has(webKey(key))
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

        const needsThumbnail = !existingThumbnails.has(thumbnailKey(item.id));
        const needsWeb = !existingWebPhotos.has(webKey(item.id));

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
  const photoKeys = objects.map(o => o.Key).filter(isPhoto);
  console.log(`Found ${photoKeys.length} photos`);

  await processExif(client, bucketName, photoKeys, publicUrl, force, concurrency ?? EXIF_CONCURRENCY);
  await processImages(client, bucketName, photoKeys, objects, concurrency ?? IMAGE_CONCURRENCY);

  console.log('\nAll done!');
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

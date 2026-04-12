import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import exifr from 'exifr';
import { createS3Client, getBucketName } from './r2client.js';

// ── constants ─────────────────────────────────────────────────────────────────

const THUMBNAIL_DIR = '.thumbnails';
const THUMBNAIL_WIDTH = 600;
const WEB_DIR = '.web';
const WEB_WIDTH = 2048;
const EXIF_CACHE_KEY = 'exif-cache.json';
const EXIF_FETCH_BYTES = 131072; // 128KB — enough for EXIF in any JPEG

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

const processExif = async (client, bucketName, photoKeys, publicUrl, force) => {
  console.log('\n── EXIF extraction ──────────────────────────────────────────');
  const cache = force ? {} : await loadJson(client, bucketName, EXIF_CACHE_KEY);
  const cached = Object.keys(cache).length;
  const toProcess = photoKeys.filter(key => cache[key] === undefined);

  if (force) console.log(`--force: reprocessing all ${photoKeys.length} photos`);
  else console.log(`Cache: ${cached} entries, ${toProcess.length} to process`);

  let processed = 0;
  for (const key of toProcess) {
    process.stdout.write(`[${processed + 1}/${toProcess.length}] ${key} → `);
    const buffer = await fetchExifChunk(publicUrl, key);
    const exif = await parseExif(buffer);
    cache[key] = exif;
    console.log(`${exif.camera || 'unknown camera'}, ${exif.lens || 'unknown lens'}`);
    processed++;

    if (processed % 10 === 0) {
      await saveJson(client, bucketName, EXIF_CACHE_KEY, cache);
      console.log('  (cache saved)');
    }
  }

  if (processed > 0) {
    await saveJson(client, bucketName, EXIF_CACHE_KEY, cache);
    console.log(`Saved cache (${Object.keys(cache).length} entries). Processed ${processed} new photos.`);
  } else {
    console.log('All photos cached, nothing to do.');
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

const processImages = async (client, bucketName, photoKeys, objects) => {
  console.log('\n── Image processing ─────────────────────────────────────────');

  const existingThumbnails = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${THUMBNAIL_DIR}/`)));
  const existingWebPhotos = new Set(objects.map(o => o.Key).filter(k => k.includes(`/${WEB_DIR}/`)));

  const photosNeedingWork = photoKeys.filter(key =>
    !existingThumbnails.has(thumbnailKey(key)) || !existingWebPhotos.has(webKey(key))
  );

  if (photosNeedingWork.length === 0) {
    console.log('All thumbnails and web-sized photos up to date.');
    return;
  }

  console.log(`Processing ${photosNeedingWork.length} photo(s)...`);

  for (const [i, key] of photosNeedingWork.entries()) {
    process.stdout.write(`[${i + 1}/${photosNeedingWork.length}] ${key} ... `);
    const original = await downloadObject(client, bucketName, key);

    const needsThumbnail = !existingThumbnails.has(thumbnailKey(key));
    const needsWeb = !existingWebPhotos.has(webKey(key));

    await Promise.all([
      needsThumbnail && makeThumbnail(original).then(buf => uploadObject(client, bucketName, thumbnailKey(key), buf)),
      needsWeb && makeWebSized(original).then(buf => uploadObject(client, bucketName, webKey(key), buf)),
    ].filter(Boolean));

    const labels = [needsThumbnail && 'thumbnail', needsWeb && 'web'].filter(Boolean).join(' + ');
    console.log(`${labels} done`);
  }
};

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const force = process.argv.includes('--force');
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) throw new Error('Missing R2_PUBLIC_URL in environment variables');

  const client = createS3Client();
  const bucketName = getBucketName();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);
  const photoKeys = objects.map(o => o.Key).filter(isPhoto);
  console.log(`Found ${photoKeys.length} photos`);

  await processExif(client, bucketName, photoKeys, publicUrl, force);
  await processImages(client, bucketName, photoKeys, objects);

  console.log('\nAll done!');
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

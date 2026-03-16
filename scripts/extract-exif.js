import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import dotenv from 'dotenv';

dotenv.config();

const CACHE_KEY = 'exif-cache.json';
const FETCH_BYTES = 131072; // 128KB — enough for EXIF in any JPEG

const createS3Client = () => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 credentials in environment variables');
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
};

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

const isPhoto = (key) => {
  if (!key.includes('/')) return false;
  if (key.includes('/.thumbnails/')) return false;
  const filename = key.split('/').pop();
  return !filename.startsWith('.') && /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(filename);
};

const loadExifCache = async (client, bucketName) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: CACHE_KEY }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch {
    return {};
  }
};

const saveExifCache = async (client, bucketName, cache) => {
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: CACHE_KEY,
    Body: JSON.stringify(cache, null, 2),
    ContentType: 'application/json',
  }));
};

const fetchPhotoChunk = async (url) => {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${FETCH_BYTES - 1}` },
  });
  return Buffer.from(await response.arrayBuffer());
};

const parseExif = async (buffer) => {
  try {
    const data = await exifr.parse(buffer, {
      pick: ['Make', 'Model', 'LensModel'],
    });
    if (!data) return {};

    const camera = [data.Make, data.Model].filter(Boolean).join(' ').trim() || null;
    const lens = data.LensModel || null;

    return { camera, lens };
  } catch {
    return {};
  }
};

const processPhoto = async (key, publicUrl, cache) => {
  if (cache[key] !== undefined) {
    return false; // already cached
  }

  const buffer = await fetchPhotoChunk(`${publicUrl}/${key}`);
  const { camera, lens } = await parseExif(buffer);

  cache[key] = { camera, lens };
  return true;
};

const extractExif = async () => {
  const bucketName = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!bucketName || !publicUrl) {
    throw new Error('Missing R2_BUCKET_NAME or R2_PUBLIC_URL in environment variables');
  }

  const client = createS3Client();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);
  const photoKeys = objects.map(o => o.Key).filter(isPhoto);
  console.log(`Found ${photoKeys.length} photos`);

  console.log('Loading existing EXIF cache...');
  const cache = await loadExifCache(client, bucketName);
  const cached = Object.keys(cache).length;
  console.log(`Cache has ${cached} entries, ${photoKeys.length - cached} to process`);

  let processed = 0;
  let skipped = 0;

  for (const key of photoKeys) {
    process.stdout.write(`[${processed + skipped + 1}/${photoKeys.length}] ${key} `);
    const didProcess = await processPhoto(key, publicUrl, cache);
    if (didProcess) {
      const { camera, lens, location } = cache[key];
      console.log(`→ ${camera || 'unknown camera'}, ${lens || 'unknown lens'}`);
      processed++;

      // Save incrementally every 10 photos to avoid losing work
      if (processed % 10 === 0) {
        await saveExifCache(client, bucketName, cache);
        console.log('  (cache saved)');
      }
    } else {
      console.log('(cached)');
      skipped++;
    }
  }

  console.log(`\nSaving final cache (${Object.keys(cache).length} entries)...`);
  await saveExifCache(client, bucketName, cache);
  console.log(`Done. Processed ${processed} new photos, skipped ${skipped} cached.`);
};

extractExif().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

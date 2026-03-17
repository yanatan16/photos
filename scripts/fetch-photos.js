import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
};

const listAllObjects = async (client, bucketName) => {
  const objects = [];
  let continuationToken = undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken,
    });

    const response = await client.send(command);

    if (response.Contents) {
      objects.push(...response.Contents);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
};

const extractYearFromSlug = (slug) => {
  const match = slug.match(/^(\d{4})-/);
  return match ? match[1] : null;
};

const formatAlbumName = (folderName) => {
  return folderName
    .replace(/^\d{4}-/, '')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const buildPhotoUrl = (publicUrl, key) => {
  return `${publicUrl}/${key}`;
};

const thumbnailKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.thumbnails', filename].join('/');
};

const loadExifCache = async (client, bucketName) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: 'exif-cache.json' }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch {
    return {};
  }
};

const parseObjects = (objects, publicUrl, exifCache) => {
  const existingThumbnails = new Set(
    objects.map(o => o.Key).filter(key => key.includes('/.thumbnails/'))
  );

  const albumMap = new Map();

  objects.forEach(obj => {
    const key = obj.Key;

    if (!key.includes('/')) {
      return;
    }

    const [albumSlug, ...filenameParts] = key.split('/');
    const filename = filenameParts.join('/');

    if (!filename || filename.startsWith('.')) {
      return;
    }

    if (!albumMap.has(albumSlug)) {
      albumMap.set(albumSlug, {
        id: albumSlug,
        name: formatAlbumName(albumSlug),
        year: extractYearFromSlug(albumSlug),
        photos: [],
      });
    }

    const thumbKey = thumbnailKey(key);
    const thumbnail = existingThumbnails.has(thumbKey)
      ? buildPhotoUrl(publicUrl, thumbKey)
      : buildPhotoUrl(publicUrl, key);

    const exif = exifCache[key] || {};
    const album = albumMap.get(albumSlug);
    album.photos.push({
      url: buildPhotoUrl(publicUrl, key),
      thumbnail,
      filename,
      date: exif.dateTaken || (obj.LastModified ? obj.LastModified.toISOString() : null),
      camera: exif.camera || null,
      lens: exif.lens || null,
      aperture: exif.aperture || null,
      shutter: exif.shutter || null,
      iso: exif.iso || null,
      focalLength: exif.focalLength || null,
    });
  });

  return Array.from(albumMap.values())
    .map(album => ({
      ...album,
      cover: album.photos.length > 0 ? album.photos[0].thumbnail : null,
      firstPhotoDate: album.photos.length > 0 ? album.photos[0].date : null,
      cameras: [...new Set(album.photos.map(p => p.camera).filter(Boolean))],
      lenses: [...new Set(album.photos.map(p => p.lens).filter(Boolean))],
    }))
    .sort((a, b) => {
      const da = a.firstPhotoDate ? new Date(a.firstPhotoDate) : new Date(0);
      const db = b.firstPhotoDate ? new Date(b.firstPhotoDate) : new Date(0);
      return db - da;
    });
};

const generateMetadata = async () => {
  const bucketName = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!bucketName || !publicUrl) {
    throw new Error('Missing R2_BUCKET_NAME or R2_PUBLIC_URL in environment variables');
  }

  console.log('Connecting to R2...');
  const client = createS3Client();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);
  console.log(`Found ${objects.length} objects`);

  console.log('Loading EXIF cache...');
  const exifCache = await loadExifCache(client, bucketName);
  console.log(`EXIF cache has ${Object.keys(exifCache).length} entries`);

  console.log('Parsing album structure...');
  const albums = parseObjects(objects, publicUrl, exifCache);
  console.log(`Generated ${albums.length} albums`);

  const metadata = { albums };

  const outputPath = join(__dirname, '..', 'src', 'data', 'photos.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(metadata, null, 2));

  console.log(`Metadata written to ${outputPath}`);
  console.log('Done!');
};

generateMetadata().catch(error => {
  console.error('Error generating metadata:', error);
  process.exit(1);
});

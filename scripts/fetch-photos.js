import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { buildFavorites } from './favorites.js';
import { photoLensFields } from './lensOverrides.js';
import { thumbnailKey, webKey, logicalPhotoKeys } from './keys.js';
import { listAllObjects } from './r2list.js';
import { byDateAscending, byDateDescending } from './dates.js';

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

const loadJson = async (client, bucketName, key, fallback = {}) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return fallback;
  }
};

export const parseObjects = (objects, publicUrl, exifCache, albumCovers, lensOverrides) => {
  const presentKeys = new Set(objects.map(o => o.Key));
  const modifiedByKey = new Map(objects.map(o => [o.Key, o.LastModified]));

  // Sorted lexicographically here only so that photos taken at the same instant
  // — two cameras, or a burst — keep a stable, reproducible order once the
  // chronological sort below runs.
  const photoKeys = [...logicalPhotoKeys(objects.map(o => o.Key))].sort();

  const albumMap = new Map();

  photoKeys.forEach(key => {
    const [albumSlug, ...filenameParts] = key.split('/');
    const filename = filenameParts.join('/');

    if (!albumMap.has(albumSlug)) {
      albumMap.set(albumSlug, {
        id: albumSlug,
        name: formatAlbumName(albumSlug),
        year: extractYearFromSlug(albumSlug),
        photos: [],
      });
    }

    const thumbKey = thumbnailKey(key);
    const wKey = webKey(key);

    // The original may not be uploaded yet, so fall back through the derivatives
    // rather than assuming it is there.
    const displayKey = presentKeys.has(key) ? key : wKey;
    const thumbnail = buildPhotoUrl(publicUrl, presentKeys.has(thumbKey) ? thumbKey : displayKey);
    const web = buildPhotoUrl(publicUrl, presentKeys.has(wKey) ? wKey : displayKey);

    const modified = modifiedByKey.get(key) ?? modifiedByKey.get(wKey) ?? null;

    const exif = exifCache[key] || {};
    const album = albumMap.get(albumSlug);
    album.photos.push({
      // Stays the original's URL even before that object exists: favorites.json,
      // album-covers.json, and lens-overrides.json are all keyed off it, and
      // PhotoGrid uses it only as identity.
      url: buildPhotoUrl(publicUrl, key),
      thumbnail,
      web,
      filename,
      date: exif.dateTaken || (modified ? modified.toISOString() : null),
      camera: exif.camera || null,
      aperture: exif.aperture || null,
      shutter: exif.shutter || null,
      iso: exif.iso || null,
      ...photoLensFields(exif, lensOverrides[key]),
    });
  });

  return Array.from(albumMap.values())
    .map(album => {
      // Chronological, so an album shot on two cameras reads as one timeline
      // instead of one run per camera. album.photos[0] is the default cover
      // and the album date, so both follow the earliest photo.
      const photos = [...album.photos].sort((a, b) => byDateAscending(a.date, b.date));
      const coverFilename = albumCovers[album.id];
      const coverPhoto = coverFilename
        ? photos.find(p => p.filename === coverFilename) ?? photos[0]
        : photos[0];
      return {
        ...album,
        photos,
        cover: coverPhoto?.thumbnail ?? null,
        firstPhotoDate: photos.length > 0 ? photos[0].date : null,
        cameras: [...new Set(photos.map(p => p.camera).filter(Boolean))],
        lenses: [...new Set(photos.map(p => p.lens).filter(Boolean))],
      };
    })
    .sort((a, b) => byDateDescending(a.firstPhotoDate, b.firstPhotoDate));
};

// The blog (joneisen.me) renders its homepage album covers from this summary.
// Publishing it with the site keeps the blog off both R2 and this repo's
// gitignored photos.json — it just fetches /photos/albums.json.
export const albumSummary = (albums) =>
  albums.map(({ id, name, cover, photos }) => ({ id, name, count: photos.length, cover }));

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
  const exifCache = await loadJson(client, bucketName, 'exif-cache.json');
  console.log(`EXIF cache has ${Object.keys(exifCache).length} entries`);

  console.log('Loading album covers...');
  const albumCovers = await loadJson(client, bucketName, 'album-covers.json');
  console.log(`Album covers: ${Object.keys(albumCovers).length} configured`);

  console.log('Loading favorites...');
  const favoriteKeys = await loadJson(client, bucketName, 'favorites.json', []);
  console.log(`Favorites: ${favoriteKeys.length} configured`);

  console.log('Loading lens overrides...');
  const lensOverrides = await loadJson(client, bucketName, 'lens-overrides.json');
  console.log(`Lens overrides: ${Object.keys(lensOverrides).length} configured`);

  console.log('Parsing album structure...');
  const albums = parseObjects(objects, publicUrl, exifCache, albumCovers, lensOverrides);
  console.log(`Generated ${albums.length} albums`);

  const favorites = buildFavorites(albums, favoriteKeys);
  console.log(`Resolved ${favorites.length} favorite photos`);

  const metadata = { albums, favorites };

  const outputPath = join(__dirname, '..', 'src', 'data', 'photos.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(metadata, null, 2));

  console.log(`Metadata written to ${outputPath}`);

  // public/ is copied verbatim into dist/, so this lands at /photos/albums.json.
  const summaryPath = join(__dirname, '..', 'public', 'albums.json');
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify({ albums: albumSummary(albums) }, null, 2));

  console.log(`Album summary written to ${summaryPath}`);
  console.log('Done!');
};

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  generateMetadata().catch(error => {
    console.error('Error generating metadata:', error);
    process.exit(1);
  });
}

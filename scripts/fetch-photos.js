import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
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

const formatAlbumName = (folderName) => {
  return folderName
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

const parseObjects = (objects, publicUrl) => {
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
        photos: [],
      });
    }

    const thumbKey = thumbnailKey(key);
    const thumbnail = existingThumbnails.has(thumbKey)
      ? buildPhotoUrl(publicUrl, thumbKey)
      : buildPhotoUrl(publicUrl, key);

    const album = albumMap.get(albumSlug);
    album.photos.push({
      url: buildPhotoUrl(publicUrl, key),
      thumbnail,
      filename,
    });
  });

  return Array.from(albumMap.values()).map(album => ({
    ...album,
    cover: album.photos.length > 0 ? album.photos[0].thumbnail : null,
  }));
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

  console.log('Parsing album structure...');
  const albums = parseObjects(objects, publicUrl);
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

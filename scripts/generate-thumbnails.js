import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();

const THUMBNAIL_WIDTH = 600;
const THUMBNAIL_DIR = '.thumbnails';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

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
  let continuationToken = undefined;

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

const resizeImage = (buffer) =>
  sharp(buffer)
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

const thumbnailKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, THUMBNAIL_DIR, filename].join('/');
};

const isPhoto = (key) => {
  if (!key.includes('/')) return false;
  if (key.includes(`/${THUMBNAIL_DIR}/`)) return false;
  const parts = key.split('/');
  const filename = parts[parts.length - 1];
  if (!filename || filename.startsWith('.')) return false;
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
};

const run = async () => {
  const bucketName = process.env.R2_BUCKET_NAME;
  if (!bucketName) throw new Error('Missing R2_BUCKET_NAME in environment variables');

  console.log('Connecting to R2...');
  const client = createS3Client();

  console.log('Listing objects...');
  const objects = await listAllObjects(client, bucketName);

  const existingThumbnails = new Set(
    objects.map(o => o.Key).filter(key => key.includes(`/${THUMBNAIL_DIR}/`))
  );

  const photosNeedingThumbnails = objects
    .map(o => o.Key)
    .filter(isPhoto)
    .filter(key => !existingThumbnails.has(thumbnailKey(key)));

  if (photosNeedingThumbnails.length === 0) {
    console.log('All thumbnails up to date.');
    return;
  }

  console.log(`Generating ${photosNeedingThumbnails.length} thumbnail(s)...`);

  for (const key of photosNeedingThumbnails) {
    const thumbKey = thumbnailKey(key);
    process.stdout.write(`  ${key} → ${thumbKey} ... `);

    const original = await downloadObject(client, bucketName, key);
    const thumbnail = await resizeImage(original);

    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: thumbKey,
      Body: thumbnail,
      ContentType: 'image/jpeg',
    }));

    console.log('done');
  }

  console.log('Done!');
};

run().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

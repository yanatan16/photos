import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const COVERS_KEY = 'album-covers.json';

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

const loadCovers = async (client, bucketName) => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: COVERS_KEY }));
    return JSON.parse(await response.Body.transformToString());
  } catch {
    return {};
  }
};

const saveCovers = async (client, bucketName, covers) => {
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: COVERS_KEY,
    Body: JSON.stringify(covers, null, 2),
    ContentType: 'application/json',
  }));
};

const run = async () => {
  const [albumSlug, filename] = process.argv.slice(2);

  if (!albumSlug || !filename) {
    throw new Error('Usage: node scripts/set-cover.js <album-slug> <photo-filename>');
  }

  const bucketName = process.env.R2_BUCKET_NAME;
  if (!bucketName) throw new Error('Missing R2_BUCKET_NAME in environment variables');

  const client = createS3Client();
  const covers = await loadCovers(client, bucketName);
  const previous = covers[albumSlug];
  covers[albumSlug] = filename;
  await saveCovers(client, bucketName, covers);

  if (previous) {
    console.log(`Cover for "${albumSlug}" updated: "${previous}" → "${filename}"`);
  } else {
    console.log(`Cover for "${albumSlug}" set to "${filename}"`);
  }
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic']);

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
};

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

const uploadFile = async (client, bucketName, folder, filePath) => {
  const filename = basename(filePath);
  const ext = extname(filename).toLowerCase();
  const key = `${folder}/${filename}`;
  const body = readFileSync(filePath);

  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: MIME_TYPES[ext] ?? 'application/octet-stream',
  }));

  return key;
};

const parseArgs = (args) => {
  if (args.length < 2) {
    throw new Error('Usage: node scripts/upload-photos.js <folder> <file1> [file2 ...]');
  }

  const [folder, ...files] = args;
  return { folder, files };
};

const validateFiles = (files) => {
  const errors = [];

  for (const file of files) {
    if (!existsSync(file)) {
      errors.push(`File not found: ${file}`);
      continue;
    }
    const ext = extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      errors.push(`Unsupported file type: ${file} (${ext})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
};

const run = async () => {
  const bucketName = process.env.R2_BUCKET_NAME;
  if (!bucketName) throw new Error('Missing R2_BUCKET_NAME in environment variables');

  const { folder, files } = parseArgs(process.argv.slice(2));
  validateFiles(files);

  const client = createS3Client();

  console.log(`Uploading ${files.length} file(s) to ${folder}/...`);

  for (const file of files) {
    const key = await uploadFile(client, bucketName, folder, file);
    console.log(`  ✓ ${key}`);
  }

  console.log('Done!');
};

run().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

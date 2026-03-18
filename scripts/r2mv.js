import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';

const run = async () => {
  const [src, dest] = process.argv.slice(2);

  if (!src || !dest) {
    throw new Error('Usage: node scripts/r2mv.js <source-key> <dest-key>');
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  console.log(`${src} → ${dest}`);

  await client.send(new CopyObjectCommand({
    Bucket: bucketName,
    CopySource: `${bucketName}/${src}`,
    Key: dest,
  }));

  await client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: src,
  }));

  console.log('Done.');
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

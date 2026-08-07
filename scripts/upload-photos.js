import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, existsSync, statSync } from 'fs';
import { basename, extname } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { withRetry } from './retry.js';

// ── constants ─────────────────────────────────────────────────────────────────

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

const DEFAULT_CONCURRENCY = 6;

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] <folder> <file1> [file2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

export const parseArgs = (args) => {
  const { concurrency, rest } = parseConcurrencyFlag(args);
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...files] = rest;
  return { folder, files, concurrency: concurrency ?? DEFAULT_CONCURRENCY };
};

const validateFiles = (files) => {
  const errors = files.flatMap((file) => {
    if (!existsSync(file)) return [`File not found: ${file}`];
    const ext = extname(file).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext) ? [] : [`Unsupported file type: ${file} (${ext})`];
  });

  if (errors.length > 0) throw new Error(errors.join('\n'));
};

// ── upload ────────────────────────────────────────────────────────────────────

// The Upload — and its read stream — are built inside the retried closure on
// purpose: a consumed stream cannot be replayed, so a retry that reused it
// would upload a zero-byte object.
const uploadFile = (client, bucketName, item, hooks) =>
  withRetry(() => {
    hooks.onAttemptStart();

    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: item.key,
        Body: createReadStream(item.filePath),
        ContentType: MIME_TYPES[extname(item.filePath).toLowerCase()] ?? 'application/octet-stream',
      },
    });

    upload.on('httpUploadProgress', ({ loaded }) => hooks.onProgress(loaded ?? 0));
    return upload.done();
  }, { onRetry: hooks.onRetry });

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const { folder, files, concurrency } = parseArgs(process.argv.slice(2));
  validateFiles(files);

  const client = createS3Client();
  const bucketName = getBucketName();

  const items = files.map(filePath => ({
    id: filePath,
    filePath,
    name: basename(filePath),
    key: `${folder}/${basename(filePath)}`,
    totalBytes: statSync(filePath).size,
  }));

  const display = createProgressDisplay({
    label: `Uploading ${items.length} photo(s) to ${folder}/`,
    items,
  });

  let results;
  try {
    results = await mapWithConcurrency(items, concurrency, async (item) => {
      display.startTask(item.id);

      try {
        await uploadFile(client, bucketName, item, {
          onAttemptStart: () => display.updateTask(item.id, 0),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
          onRetry: ({ attempt, attempts }) => {
            display.updateTask(item.id, 0);
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);
          },
        });
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
      return item.key;
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`\n${results.length - failures.length}/${results.length} uploaded to ${folder}/`);

  if (failures.length > 0) {
    console.error('\nFailed:');
    for (const failure of failures) {
      console.error(`  ${failure.item.key}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }
};

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  run().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

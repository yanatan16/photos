import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { makeThumbnail, makeWebSized } from './derivatives.js';
import { uploadToR2, SUPPORTED_EXTENSIONS } from './upload.js';
import { thumbnailKey, webKey } from './keys.js';
import { createPendingQueue } from './pendingOriginals.js';

// ── constants ─────────────────────────────────────────────────────────────────

const UNDECODABLE_EXTENSIONS = new Set(['.heic', '.heif']);

const DEFAULT_CONCURRENCY = 6;

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] <folder> <file1> [file2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

export const parseArgs = (args) => {
  const { concurrency, rest } = parseConcurrencyFlag(args);
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...files] = rest;
  return { folder, files, concurrency: concurrency ?? DEFAULT_CONCURRENCY };
};

export const validateFiles = (files) => {
  const errors = files.flatMap((file) => {
    const ext = extname(file).toLowerCase();

    if (UNDECODABLE_EXTENSIONS.has(ext)) {
      return [`${file} cannot be resized locally (${ext} decoding is unavailable). ` +
              `Convert it to JPEG first, e.g. \`sips -s format jpeg "${file}" --out "${file.replace(/\.[^.]+$/, '.jpg')}"\`.`];
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) return [`Unsupported file type: ${file} (${ext})`];
    if (!existsSync(file)) return [`File not found: ${file}`];
    return [];
  });

  if (errors.length > 0) throw new Error(errors.join('\n'));
};

// ── upload ────────────────────────────────────────────────────────────────────

// The thumbnail and web uploads (sequential — see the send site below) each
// report an absolute cumulative `loaded`, not a delta. They're tracked in
// separate slots and summed so the task's progress reflects both.
const createByteTracker = (report) => {
  const loaded = { thumbnail: 0, web: 0 };
  return (which) => (bytes) => {
    loaded[which] = bytes;
    report(loaded.thumbnail + loaded.web);
  };
};

const uploadPhoto = async (client, bucketName, item, hooks) => {
  const original = await readFile(item.filePath);

  hooks.onNote('resizing');
  const [thumbnail, web] = await Promise.all([makeThumbnail(original), makeWebSized(original)]);

  hooks.onTotal(thumbnail.length + web.length);
  hooks.onNote('uploading');

  const track = createByteTracker(hooks.onProgress);
  const send = (which, key, body) => uploadToR2(client, bucketName, {
    key,
    contentType: 'image/jpeg',
    createBody: () => body,
  }, {
    onProgress: track(which),
    onRetry: ({ attempt, attempts }) => {
      track(which)(0);
      hooks.onNote(`retry ${attempt}/${attempts - 1}`);
    },
  });

  // Sequential, not Promise.all: `logicalPhotoKeys` (keys.js) treats a `.web/`
  // key as proof the photo exists but deliberately does NOT treat a thumbnail
  // alone as such (see `logicalPhotoKeys does not invent a photo from a
  // thumbnail alone` in keys.test.js). Uploading the thumbnail first means a
  // partial failure can only ever leave an invisible thumbnail orphan, never
  // a half-published photo.
  await send('thumbnail', thumbnailKey(item.key), thumbnail);
  await send('web', webKey(item.key), web);
};

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const { folder, files, concurrency } = parseArgs(process.argv.slice(2));
  validateFiles(files);

  const client = createS3Client();
  const bucketName = getBucketName();
  const queue = createPendingQueue();

  const items = files.map(filePath => ({
    id: filePath,
    filePath,
    name: basename(filePath),
    key: `${folder}/${basename(filePath)}`,
    // Byte totals arrive after the resize — the original's size on disk is not
    // a quantity this script uploads any more.
    totalBytes: null,
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
        await uploadPhoto(client, bucketName, item, {
          onNote: (note) => display.noteTask(item.id, note),
          onTotal: (total) => display.setTaskTotal(item.id, total),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
        });
        // Queued only after both derivatives land. A photo whose images failed
        // is one to re-run whole, not one to leave queued with nothing in R2.
        await queue.add({ localPath: resolve(item.filePath), key: item.key });
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
  console.log(`${queue.load().length} original(s) queued — run \`npm run upload:originals\` on fast wifi.`);

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

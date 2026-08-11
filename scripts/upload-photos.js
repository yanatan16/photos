import { readFile } from 'fs/promises';
import { basename, resolve } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { makeThumbnail, makeWebSized } from './derivatives.js';
import { uploadToR2 } from './upload.js';
import { thumbnailKey, webKey } from './keys.js';
import { createPendingQueue } from './pendingOriginals.js';
import { listAlbumKeys } from './r2list.js';
import {
  expandPaths,
  partitionCandidates,
  needsUpload,
  assertNoKeyCollisions,
} from './candidates.js';

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 6;

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] [--force] <album> <path1> [path2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

export const parseArgs = (args) => {
  const force = args.includes('--force');
  const { concurrency, rest } = parseConcurrencyFlag(args.filter(arg => arg !== '--force'));
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...paths] = rest;
  return { folder, paths, concurrency: concurrency ?? DEFAULT_CONCURRENCY, force };
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

// ── selection ─────────────────────────────────────────────────────────────────

// Which candidates R2 does not already have (or has queued locally). `--force`
// skips the listing entirely rather than listing and ignoring the result —
// the filter is the listing's only consumer.
const selectPending = async (client, bucketName, folder, candidates, queuedKeys, force) => {
  if (force) {
    console.log(`--force: uploading all ${candidates.length} photo(s)`);
    return candidates;
  }

  const presentKeys = await listAlbumKeys(client, bucketName, folder);
  const pending = candidates.filter(candidate => needsUpload(presentKeys, queuedKeys, candidate.key));

  console.log(`${candidates.length - pending.length} already uploaded — skipping.`);
  return pending;
};

// ── main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const { folder, paths, concurrency, force } = parseArgs(process.argv.slice(2));

  const { files: foundFiles, skipped } = partitionCandidates(expandPaths(paths));
  for (const note of skipped) console.warn(`Skipped: ${note}`);

  // `upload album dir dir/a.jpg` names the same file two ways; dedupe so it's
  // read, resized, and uploaded once instead of twice.
  const files = [...new Set(foundFiles)];

  const candidates = files.map(filePath => ({
    filePath,
    key: `${folder}/${basename(filePath)}`,
  }));
  // Before any network work: two files claiming one key would overwrite each
  // other, and the second run would then call both of them already uploaded.
  assertNoKeyCollisions(candidates);
  console.log(`${candidates.length} photo(s) found.`);

  if (candidates.length === 0) {
    console.log('No photos found.');
    return;
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  // Built up front — a local file read with no network cost — so selectPending
  // can treat a queued original as accounted-for even though it hasn't hit R2.
  const queue = createPendingQueue();
  const queuedKeys = new Set(queue.load().map(entry => entry.key));

  const pending = await selectPending(client, bucketName, folder, candidates, queuedKeys, force);
  if (pending.length === 0) {
    console.log('Everything is already uploaded.');
    return;
  }

  const items = pending.map(candidate => ({
    id: candidate.filePath,
    filePath: candidate.filePath,
    name: basename(candidate.filePath),
    key: candidate.key,
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

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
import { withRetry } from './retry.js';
import { parseExif } from './exif.js';
import { loadExifCache, saveExifCache } from './exifStore.js';
import { triggerDeploy, WORKFLOW_FILE } from './deploy.js';
import {
  expandPaths,
  partitionCandidates,
  needsUpload,
  assertNoKeyCollisions,
} from './candidates.js';

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 6;

const BOOLEAN_FLAGS = ['--force', '--deploy'];

const USAGE = 'Usage: node scripts/upload-photos.js [--concurrency N] [--force] [--deploy] <album> <path1> [path2 ...]';

// ── argument handling ─────────────────────────────────────────────────────────

const takeBooleanFlags = (args) => ({
  set: new Set(args.filter(arg => BOOLEAN_FLAGS.includes(arg))),
  rest: args.filter(arg => !BOOLEAN_FLAGS.includes(arg)),
});

export const parseArgs = (args) => {
  const { set, rest: withoutFlags } = takeBooleanFlags(args);
  const { concurrency, rest } = parseConcurrencyFlag(withoutFlags);
  if (rest.length < 2) throw new Error(USAGE);

  const [folder, ...paths] = rest;
  return {
    folder,
    paths,
    concurrency: concurrency ?? DEFAULT_CONCURRENCY,
    force: set.has('--force'),
    deploy: set.has('--deploy'),
  };
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
  // Read from the whole original on disk: a richer source than the 128KB range
  // read process.js falls back to, and it costs nothing here — the bytes are
  // already in hand.
  const [thumbnail, web, exif] = await Promise.all([
    makeThumbnail(original),
    makeWebSized(original),
    parseExif(original),
  ]);

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

  return exif;
};

// ── EXIF cache ────────────────────────────────────────────────────────────────

// Only photos that actually landed in R2. One whose upload failed has nothing
// there to describe, and caching it would make process.js treat the retry as
// already done.
export const exifFromResults = (results) =>
  Object.fromEntries(
    results
      .filter(result => !result.error)
      .map(result => [result.value.key, result.value.exif]),
  );

// One read-merge-write for the whole run rather than a save per photo: the
// cache is a single JSON object, and concurrent workers each writing all of it
// would drop each other's entries.
const cacheExif = async (exifByKey) => {
  const count = Object.keys(exifByKey).length;
  if (count === 0) return true;

  try {
    const cache = await withRetry(() => loadExifCache());
    await withRetry(() => saveExifCache({ ...cache, ...exifByKey }));
    console.log(`EXIF cached for ${count} photo(s).`);
    return true;
  } catch (error) {
    // The photos are already in R2, so this is not worth failing the upload
    // over — process.js exists to backfill exactly this.
    console.error(`\nEXIF cache not saved: ${error.message}`);
    console.error('The photos uploaded fine — run `npm run process` to backfill their EXIF.');
    process.exitCode = 1;
    return false;
  }
};

// ── deploy ────────────────────────────────────────────────────────────────────

// Publishing an incomplete album, or one whose EXIF never reached the cache,
// puts a visibly wrong album on the site: without EXIF, fetch-photos.js dates
// every photo from R2's LastModified, which mis-sorts the album and can hand it
// the wrong cover. Both are worth holding the deploy back for.
export const deploySkipReason = ({ failureCount, exifSaved }) => {
  if (failureCount > 0) {
    return `${failureCount} photo(s) failed.\nRe-run the same command to retry just those.`;
  }

  if (!exifSaved) {
    return 'EXIF was not cached, so the album would publish with upload-time dates.'
      + '\nRun `npm run process`, then re-run this command.';
  }

  return null;
};

const deploy = async () => {
  try {
    console.log(`\nTriggering ${WORKFLOW_FILE}...`);
    console.log(`  ${await triggerDeploy()}`);
  } catch (error) {
    console.error(`\nDeploy not triggered: ${error.message}`);
    process.exitCode = 1;
  }
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
  const { folder, paths, concurrency, force, deploy: shouldDeploy } = parseArgs(process.argv.slice(2));

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

  // No deploy here: the paths matched nothing at all, which is a typo far more
  // often than it is an instruction to publish.
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
    // Still deploys: asking for one explicitly and getting nothing because a
    // previous run already did the uploading is the case where you most want
    // to re-publish without --force faking new work.
    if (shouldDeploy) await deploy();
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

      let exif;
      try {
        exif = await uploadPhoto(client, bucketName, item, {
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
      return { key: item.key, exif };
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`\n${results.length - failures.length}/${results.length} uploaded to ${folder}/`);

  const exifSaved = await cacheExif(exifFromResults(results));

  console.log(`${queue.load().length} original(s) queued — run \`npm run upload:originals\` on fast wifi.`);

  if (failures.length > 0) {
    console.error('\nFailed:');
    for (const failure of failures) {
      console.error(`  ${failure.item.key}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }

  if (!shouldDeploy) return;

  const skip = deploySkipReason({ failureCount: failures.length, exifSaved });
  if (skip) {
    console.error(`\nSkipping --deploy: ${skip}`);
    return;
  }

  await deploy();
};

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  run().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

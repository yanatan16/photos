import { createReadStream, existsSync, statSync } from 'fs';
import { basename } from 'path';
import { createS3Client, getBucketName } from './r2client.js';
import { mapWithConcurrency, parseConcurrencyFlag } from './concurrency.js';
import { createProgressDisplay } from './progress.js';
import { uploadToR2, contentTypeFor } from './upload.js';
import { createPendingQueue } from './pendingOriginals.js';

const DEFAULT_CONCURRENCY = 6;

const run = async () => {
  const { concurrency } = parseConcurrencyFlag(process.argv.slice(2));
  const queue = createPendingQueue();
  const pending = queue.load();

  if (pending.length === 0) {
    console.log('No originals pending.');
    return;
  }

  const missing = pending.filter(entry => !existsSync(entry.localPath));
  const ready = pending.filter(entry => existsSync(entry.localPath));

  // A moved or deleted original will never upload. Report it once and drop it
  // rather than re-reporting it on every future run.
  for (const entry of missing) {
    console.warn(`Dropping ${entry.key} — no longer at ${entry.localPath}`);
    await queue.remove(entry.key);
  }

  if (ready.length === 0) {
    console.log('Nothing left to upload.');
    return;
  }

  const client = createS3Client();
  const bucketName = getBucketName();

  const items = ready.map(entry => ({
    id: entry.key,
    key: entry.key,
    localPath: entry.localPath,
    name: basename(entry.localPath),
    totalBytes: statSync(entry.localPath).size,
  }));

  const display = createProgressDisplay({
    label: `Uploading ${items.length} original(s)`,
    items,
  });

  let results;
  try {
    results = await mapWithConcurrency(items, concurrency ?? DEFAULT_CONCURRENCY, async (item) => {
      display.startTask(item.id);

      try {
        await uploadToR2(client, bucketName, {
          key: item.key,
          contentType: contentTypeFor(item.localPath),
          createBody: () => createReadStream(item.localPath),
        }, {
          onAttemptStart: () => display.updateTask(item.id, 0),
          onProgress: (loaded) => display.updateTask(item.id, loaded),
          onRetry: ({ attempt, attempts }) => {
            display.updateTask(item.id, 0);
            display.noteTask(item.id, `retry ${attempt}/${attempts - 1}`);
          },
        });
        // Removed one at a time as each lands, so Ctrl-C leaves an accurate
        // manifest and a re-run resumes instead of restarting.
        await queue.remove(item.key);
      } catch (error) {
        display.finishTask(item.id, { error });
        throw error;
      }

      display.finishTask(item.id);
    });
  } finally {
    display.stop();
  }

  const failures = results.filter(result => result.error);
  console.log(`\n${results.length - failures.length}/${results.length} original(s) uploaded.`);
  console.log(`${queue.load().length} still pending.`);

  if (failures.length > 0) {
    console.error('\nFailed:');
    for (const failure of failures) {
      console.error(`  ${failure.item.key}: ${failure.error.message}`);
    }
    process.exitCode = 1;
  }
};

run().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

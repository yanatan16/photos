import { loadCovers, saveCovers } from './coversStore.js';

const run = async () => {
  const [albumSlug, filename] = process.argv.slice(2);

  if (!albumSlug || !filename) {
    throw new Error('Usage: node scripts/set-cover.js <album-slug> <photo-filename>');
  }

  const covers = await loadCovers();
  const previous = covers[albumSlug];
  covers[albumSlug] = filename;
  await saveCovers(covers);

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

import { loadLensOverrides, saveLensOverrides } from './lensOverridesStore.js';
import { setLensOverride } from './lensOverrides.js';
import { favoriteKey as photoKey } from './favorites.js';

const run = async () => {
  const [albumSlug, filename, ...lensParts] = process.argv.slice(2);
  const lens = lensParts.join(' ').trim();

  if (!albumSlug || !filename) {
    throw new Error('Usage: npm run set-lens -- <album-slug> <photo-filename> "<lens name>" (omit lens name to clear)');
  }

  const key = photoKey(albumSlug, filename);
  const current = await loadLensOverrides();
  const { overrides, action } = setLensOverride(current, key, lens);

  if (action === 'unchanged') {
    console.log(`No lens override for ${key}, nothing to clear`);
    return;
  }

  await saveLensOverrides(overrides);
  console.log(action === 'set'
    ? `Lens for ${key} set to "${lens}"`
    : `Lens override for ${key} cleared`);
};

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

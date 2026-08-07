import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

// ── location ──────────────────────────────────────────────────────────────────

export const PENDING_PATH = fileURLToPath(new URL('../.pending-originals.json', import.meta.url));

// ── pure operations ───────────────────────────────────────────────────────────

export const addPending = (entries, entry) =>
  [...entries.filter(pending => pending.key !== entry.key), entry];

export const removePending = (entries, key) =>
  entries.filter(pending => pending.key !== key);

// A pending entry is "under" a key if it matches exactly (a single-file key)
// or falls beneath it as an album prefix — used to flag entries left stale by
// an R2 operation that changed or removed that key without touching the queue.
export const pendingEntriesUnder = (entries, key) =>
  entries.filter(pending => pending.key === key || pending.key.startsWith(`${key}/`));

export const parsePending = (text) => {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// ── queue ─────────────────────────────────────────────────────────────────────

const readFile = () => (existsSync(PENDING_PATH) ? readFileSync(PENDING_PATH, 'utf8') : '[]');
const writeFile = (text) => writeFileSync(PENDING_PATH, text);

export const createPendingQueue = ({ read = readFile, write = writeFile } = {}) => {
  const load = () => parsePending(read());

  // Every upload worker appends to the same manifest. The read AND the write
  // both have to sit inside the chain — reading outside it lets two workers
  // start from the same snapshot and the second write loses the first entry.
  let pending = Promise.resolve();
  const mutate = (change) => {
    const result = pending.then(() => {
      const next = change(load());
      write(JSON.stringify(next, null, 2));
      return next;
    });
    // Keep the chain alive after a failure: a rejected `pending` would make
    // every later add/remove reject with the same stale error.
    pending = result.catch(() => {});
    return result;
  };

  return {
    load,
    add: (entry) => mutate(entries => addPending(entries, entry)),
    remove: (key) => mutate(entries => removePending(entries, key)),
  };
};

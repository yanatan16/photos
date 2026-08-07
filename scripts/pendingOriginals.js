import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

// ── location ──────────────────────────────────────────────────────────────────

export const PENDING_PATH = fileURLToPath(new URL('../.pending-originals.json', import.meta.url));

// ── pure operations ───────────────────────────────────────────────────────────

export const addPending = (entries, entry) =>
  [...entries.filter(pending => pending.key !== entry.key), entry];

export const removePending = (entries, key) =>
  entries.filter(pending => pending.key !== key);

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
    pending = pending.then(() => {
      const next = change(load());
      write(JSON.stringify(next, null, 2));
      return next;
    });
    return pending;
  };

  return {
    load,
    add: (entry) => mutate(entries => addPending(entries, entry)),
    remove: (key) => mutate(entries => removePending(entries, key)),
  };
};

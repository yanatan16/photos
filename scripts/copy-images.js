import { readdirSync, statSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';

// ── constants ─────────────────────────────────────────────────────────────────

const RAW_EXTENSIONS = new Set(['.raf', '.dng']); // Fujifilm = .RAF, Leica = .DNG
const VOLUMES_DIR = '/Volumes';
const PHOTOGRAPH_DIR = join(homedir(), 'Photograph');

// ── camera card discovery ─────────────────────────────────────────────────────

const findCameraCards = () =>
  readdirSync(VOLUMES_DIR)
    .map(name => join(VOLUMES_DIR, name))
    .filter(volume => existsSync(join(volume, 'DCIM')));

// ── file selection ────────────────────────────────────────────────────────────

const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });

const isRawFile = (path) => RAW_EXTENSIONS.has(extname(path).toLowerCase());

// ── destination layout ───────────────────────────────────────────────────────

// Photos land in ~/Photograph/<year>/<date> <event>, dated by when each
// shot was taken (file mtime), so a card spanning days splits cleanly.
const captureDate = (path) => {
  const taken = statSync(path).mtime;
  const year = String(taken.getFullYear());
  const month = String(taken.getMonth() + 1).padStart(2, '0');
  const day = String(taken.getDate()).padStart(2, '0');
  return { year, date: `${year}-${month}-${day}` };
};

const destinationDir = (year, date, event) =>
  join(PHOTOGRAPH_DIR, year, event ? `${date} ${event}` : date);

const alreadyCopied = (src, dest) =>
  existsSync(dest) && statSync(dest).size === statSync(src).size;

// ── main ──────────────────────────────────────────────────────────────────────

const run = () => {
  const event = process.argv.slice(2).join(' ').trim();

  const cards = findCameraCards();
  if (cards.length === 0) {
    throw new Error(
      'No camera card found. Insert an SD card, or set the camera USB mode to "Card Reader".'
    );
  }
  if (cards.length > 1) {
    throw new Error(`Multiple cards found:\n  ${cards.join('\n  ')}\nLeave only one connected.`);
  }
  const card = cards[0];
  console.log(`Found card: ${card}`);

  const rawFiles = walkFiles(join(card, 'DCIM')).filter(isRawFile);
  if (rawFiles.length === 0) {
    console.log('No RAW files (.RAF / .DNG) found on the card.');
    return;
  }
  console.log(`Found ${rawFiles.length} RAW file(s)${event ? ` for "${event}"` : ''}.`);

  const folders = new Set();
  let copied = 0;
  let skipped = 0;

  for (const src of rawFiles) {
    const { year, date } = captureDate(src);
    const destDir = destinationDir(year, date, event);
    mkdirSync(destDir, { recursive: true });
    folders.add(destDir);

    const dest = join(destDir, basename(src));
    if (alreadyCopied(src, dest)) {
      skipped++;
    } else {
      copyFileSync(src, dest);
      copied++;
    }
    process.stdout.write(`\r  ${copied} copied, ${skipped} skipped`);
  }

  process.stdout.write('\n');
  console.log('Done.');
  for (const folder of folders) console.log(`  → ${folder}`);
};

try {
  run();
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

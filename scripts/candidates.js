import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { SUPPORTED_EXTENSIONS } from './upload.js';
import { thumbnailKey, webKey } from './keys.js';

// ── path expansion ────────────────────────────────────────────────────────────

// A missing path is deliberately not an error here. It flows through as an
// explicit entry so partitionCandidates reports "File not found" with the rest
// of the validation, instead of a raw fs error escaping mid-expansion.
//
// Only ENOENT gets that treatment. A permission error or a broken symlink
// means the path exists and something else is wrong, and reporting those as
// "File not found" sends you looking in the wrong place.
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

const readDirectory = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory ${path}: ${error.message}`);
  }
};

// Tags each candidate with whether the user *named* it or the script *found*
// it inside a directory — the distinction partitionCandidates branches on.
// Hidden entries are dropped: `.DS_Store` is noise, but an AppleDouble
// `._IMG_0001.jpg` sidecar carries a real image extension and would otherwise
// upload as a corrupt photo.
export const expandPaths = (paths) => paths.flatMap((path) => {
  if (!isDirectory(path)) return [{ filePath: path, explicit: true }];

  return readDirectory(path)
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => ({ filePath: join(path, entry.name), explicit: false }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
});

// ── validation ────────────────────────────────────────────────────────────────

const UNDECODABLE_EXTENSIONS = new Set(['.heic', '.heif']);

// Checked in this order so the HEIC hint wins over the generic
// "unsupported type" message for a file that is genuinely a photo.
const problemWith = (filePath) => {
  const ext = extname(filePath).toLowerCase();

  if (UNDECODABLE_EXTENSIONS.has(ext)) {
    return `${filePath} cannot be resized locally (${ext} decoding is unavailable). ` +
           `Convert it to JPEG first, e.g. \`sips -s format jpeg "${filePath}" --out "${filePath.replace(/\.[^.]+$/, '.jpg')}"\`.`;
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) return `Unsupported file type: ${filePath} (${ext})`;
  if (!existsSync(filePath)) return `File not found: ${filePath}`;
  return null;
};

// A file the user named is a file the user wants: a problem with it is an
// error. A file found inside a directory is just something that was in the
// folder, so `.xmp` sidecars and RAW files drop out silently. HEIC is the one
// exception — it *is* a photo they probably want, so it is reported rather
// than dropped, but it must not fail the batch the way naming it would.
export const partitionCandidates = (entries) => {
  const files = [];
  const skipped = [];
  const errors = [];

  for (const { filePath, explicit } of entries) {
    const problem = problemWith(filePath);

    if (!problem) files.push(filePath);
    else if (explicit) errors.push(problem);
    else if (UNDECODABLE_EXTENSIONS.has(extname(filePath).toLowerCase())) skipped.push(problem);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { files, skipped };
};

// ── already-uploaded check ────────────────────────────────────────────────────

// Both derivatives, not just `.web/`. `logicalPhotoKeys` treats a web copy
// alone as proof a photo exists, which is right for *display* — but an upload
// that died between the thumbnail send and the web send should be redone, so
// the bar for skipping work is higher than the bar for showing a photo.
export const needsUpload = (presentKeys, key) =>
  !presentKeys.has(thumbnailKey(key)) || !presentKeys.has(webKey(key));

// ── collisions ────────────────────────────────────────────────────────────────

// The R2 key comes from the basename, so two directories holding the same
// filename both claim one key and the second upload silently destroys the
// first. Worse, the next run then sees the key as present and reports both
// photos as already uploaded. Refuse the whole batch instead.
export const assertNoKeyCollisions = (candidates) => {
  const pathsByKey = new Map();
  for (const { filePath, key } of candidates) {
    const paths = pathsByKey.get(key) ?? new Set();
    paths.add(filePath);
    pathsByKey.set(key, paths);
  }

  const collisions = [...pathsByKey]
    .filter(([, paths]) => paths.size > 1)
    .map(([key, paths]) => `  ${key} ← ${[...paths].join(', ')}`);

  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} filename collision(s) — these would overwrite each other in R2:\n` +
      `${collisions.join('\n')}\n` +
      'Rename the files or upload the folders to separate albums.'
    );
  }
};

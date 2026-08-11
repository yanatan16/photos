import { readdirSync, statSync } from 'fs';
import { join } from 'path';

// ── path expansion ────────────────────────────────────────────────────────────

// A missing path is deliberately not an error here. It flows through as an
// explicit entry so partitionCandidates reports "File not found" with the rest
// of the validation, instead of a raw fs error escaping mid-expansion.
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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

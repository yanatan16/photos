import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expandPaths, partitionCandidates, needsUpload } from './candidates.js';

// Real files on disk: expandPaths asks the filesystem what a path is, and
// partitionCandidates (Task 3) asks whether it exists. Stubbing fs would test
// the stub instead of the behaviour.
const fixture = ({ dirs = [], files = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'candidates-'));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) writeFileSync(join(root, file), '');
  return root;
};

test('expandPaths keeps a plain file as an explicit entry', () => {
  const root = fixture({ files: ['a.jpg'] });

  assert.deepEqual(expandPaths([join(root, 'a.jpg')]), [
    { filePath: join(root, 'a.jpg'), explicit: true },
  ]);
});

test('expandPaths expands a directory into its files, sorted, non-explicit', () => {
  const root = fixture({ files: ['b.jpg', 'a.jpg'] });

  assert.deepEqual(expandPaths([root]), [
    { filePath: join(root, 'a.jpg'), explicit: false },
    { filePath: join(root, 'b.jpg'), explicit: false },
  ]);
});

test('expandPaths does not descend into subdirectories', () => {
  const root = fixture({ dirs: ['nested'], files: ['a.jpg', join('nested', 'b.jpg')] });

  assert.deepEqual(expandPaths([root]).map(entry => entry.filePath), [join(root, 'a.jpg')]);
});

test('expandPaths drops hidden files found inside a directory', () => {
  const root = fixture({ files: ['a.jpg', '.DS_Store', '._a.jpg'] });

  // `._a.jpg` is the dangerous one: an AppleDouble sidecar carries a real
  // image extension and would upload as a corrupt photo.
  assert.deepEqual(expandPaths([root]).map(entry => entry.filePath), [join(root, 'a.jpg')]);
});

test('expandPaths leaves a nonexistent path as an explicit entry', () => {
  // Not an error here — it flows through so partitionCandidates reports
  // "File not found" rather than a raw fs throw escaping.
  assert.deepEqual(expandPaths(['/nope/missing.jpg']), [
    { filePath: '/nope/missing.jpg', explicit: true },
  ]);
});

test('expandPaths handles a mixed list of files and directories', () => {
  const root = fixture({ dirs: ['album'], files: ['loose.jpg', join('album', 'a.jpg')] });

  assert.deepEqual(expandPaths([join(root, 'album'), join(root, 'loose.jpg')]), [
    { filePath: join(root, 'album', 'a.jpg'), explicit: false },
    { filePath: join(root, 'loose.jpg'), explicit: true },
  ]);
});

test('expandPaths contributes nothing for an empty directory', () => {
  assert.deepEqual(expandPaths([fixture({})]), []);
});

test('expandPaths surfaces a stat failure that is not ENOENT', () => {
  if (process.getuid?.() === 0) return;

  const root = fixture({ dirs: ['locked'] });
  chmodSync(join(root, 'locked'), 0o000);

  try {
    // A path under an unsearchable directory fails with EACCES, not ENOENT.
    // Reporting that as "File not found" would send you looking in the wrong
    // place, so it must escape rather than be swallowed.
    assert.throws(() => expandPaths([join(root, 'locked', 'a.jpg')]), { code: 'EACCES' });
  } finally {
    chmodSync(join(root, 'locked'), 0o755);
  }
});

// ── partitionCandidates ───────────────────────────────────────────────────────

const named = (filePath) => ({ filePath, explicit: true });
const found = (filePath) => ({ filePath, explicit: false });

test('partitionCandidates accepts a supported image either way', () => {
  const root = fixture({ files: ['a.jpg', 'b.png'] });
  const { files, skipped } = partitionCandidates([
    named(join(root, 'a.jpg')),
    found(join(root, 'b.png')),
  ]);

  assert.deepEqual(files, [join(root, 'a.jpg'), join(root, 'b.png')]);
  assert.deepEqual(skipped, []);
});

test('partitionCandidates throws for a named file that is missing', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/missing.jpg')]),
    /File not found: \/nope\/missing\.jpg/,
  );
});

test('partitionCandidates throws for a named heic with an actionable message', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/photo.heic')]),
    /cannot be resized locally.*[Cc]onvert/s,
  );
});

test('partitionCandidates throws for a named unsupported extension', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/notes.txt')]),
    /Unsupported file type/,
  );
});

test('partitionCandidates joins every named-file error into one message', () => {
  assert.throws(
    () => partitionCandidates([named('/nope/a.txt'), named('/nope/b.txt')]),
    /a\.txt[\s\S]*b\.txt/,
  );
});

test('partitionCandidates reports a found heic as skipped instead of failing', () => {
  const root = fixture({ files: ['a.jpg'] });
  const { files, skipped } = partitionCandidates([
    found(join(root, 'a.jpg')),
    found(join(root, 'shot.heic')),
  ]);

  // One HEIC in the folder must not block the other 200 photos.
  assert.deepEqual(files, [join(root, 'a.jpg')]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /shot\.heic.*cannot be resized locally/s);
});

test('partitionCandidates drops other found non-images silently', () => {
  const root = fixture({ files: ['a.jpg'] });
  const { files, skipped } = partitionCandidates([
    found(join(root, 'a.jpg')),
    found(join(root, 'a.xmp')),
    found(join(root, 'a.cr2')),
  ]);

  assert.deepEqual(files, [join(root, 'a.jpg')]);
  assert.deepEqual(skipped, []);
});

test('partitionCandidates handles a whole real folder end to end', () => {
  const root = fixture({ files: ['a.jpg', 'b.jpeg', 'notes.txt', '.DS_Store'] });
  const { files, skipped } = partitionCandidates(expandPaths([root]));

  assert.deepEqual(files, [join(root, 'a.jpg'), join(root, 'b.jpeg')]);
  assert.deepEqual(skipped, []);
});

// ── needsUpload ───────────────────────────────────────────────────────────────

const KEY = '2026-italy/a.jpg';
const THUMBNAIL = '2026-italy/.thumbnails/a.jpg';
const WEB = '2026-italy/.web/a.jpg';

test('needsUpload is false when both derivatives are present', () => {
  assert.equal(needsUpload(new Set([THUMBNAIL, WEB]), KEY), false);
});

test('needsUpload is true when only the thumbnail is present', () => {
  // A run that died between the two sends is redone, not left half-published.
  assert.equal(needsUpload(new Set([THUMBNAIL]), KEY), true);
});

test('needsUpload is true when only the web derivative is present', () => {
  assert.equal(needsUpload(new Set([WEB]), KEY), true);
});

test('needsUpload is true when neither derivative is present', () => {
  assert.equal(needsUpload(new Set(), KEY), true);
});

test('needsUpload ignores the original — derivatives are what the site serves', () => {
  assert.equal(needsUpload(new Set([KEY]), KEY), true);
});

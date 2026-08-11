import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expandPaths } from './candidates.js';

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

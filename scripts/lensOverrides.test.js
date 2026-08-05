import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLensOverride, photoLensFields, isManualLensAperture } from './lensOverrides.js';

test('setLensOverride sets a lens for a photo key', () => {
  const { overrides, action } = setLensOverride({}, 'x/a.jpg', 'Helios MC 44-3 58mm F2');
  assert.deepEqual(overrides, { 'x/a.jpg': 'Helios MC 44-3 58mm F2' });
  assert.equal(action, 'set');
});

test('setLensOverride replaces an existing override', () => {
  const { overrides, action } = setLensOverride({ 'x/a.jpg': 'Old Lens' }, 'x/a.jpg', 'New Lens');
  assert.deepEqual(overrides, { 'x/a.jpg': 'New Lens' });
  assert.equal(action, 'set');
});

test('setLensOverride clears an override when lens is empty', () => {
  const { overrides, action } = setLensOverride({ 'x/a.jpg': 'Old Lens', 'y/b.jpg': 'Kept' }, 'x/a.jpg', '');
  assert.deepEqual(overrides, { 'y/b.jpg': 'Kept' });
  assert.equal(action, 'cleared');
});

test('setLensOverride reports unchanged when clearing a missing key', () => {
  const { overrides, action } = setLensOverride({}, 'x/a.jpg', '');
  assert.deepEqual(overrides, {});
  assert.equal(action, 'unchanged');
});

test('setLensOverride does not mutate the input', () => {
  const input = { 'x/a.jpg': 'Old Lens' };
  setLensOverride(input, 'x/a.jpg', 'New Lens');
  setLensOverride(input, 'x/a.jpg', '');
  assert.deepEqual(input, { 'x/a.jpg': 'Old Lens' });
});

test('isManualLensAperture matches the f/1 sentinel', () => {
  assert.equal(isManualLensAperture('f/1'), true);
  assert.equal(isManualLensAperture('f/1.0'), true);
  assert.equal(isManualLensAperture('f/2'), false);
  assert.equal(isManualLensAperture(null), false);
});

test('photoLensFields prefers the override over EXIF lens', () => {
  const fields = photoLensFields({ lens: 'FE 28-70mm', focalLength: '50mm', aperture: 'f/4' }, 'Helios MC 44-3 58mm F2');
  assert.deepEqual(fields, { lens: 'Helios MC 44-3 58mm F2', focalLength: '50mm' });
});

test('photoLensFields falls back to EXIF lens without an override', () => {
  const fields = photoLensFields({ lens: 'FE 28-70mm', focalLength: '50mm', aperture: 'f/4' }, undefined);
  assert.deepEqual(fields, { lens: 'FE 28-70mm', focalLength: '50mm' });
});

test('photoLensFields omits focal length for a manual lens (f/1 aperture)', () => {
  const fields = photoLensFields({ lens: null, focalLength: '50mm', aperture: 'f/1' }, 'Helios MC 44-3 58mm F2');
  assert.deepEqual(fields, { lens: 'Helios MC 44-3 58mm F2', focalLength: null });
});

test('photoLensFields returns nulls for empty EXIF', () => {
  assert.deepEqual(photoLensFields({}, undefined), { lens: null, focalLength: null });
});

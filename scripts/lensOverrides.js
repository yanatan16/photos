// Cameras record aperture as f/1 (or f/1.0) when a lens has no electronic
// contacts, so any focal length alongside it is a body default, not the truth.
const MANUAL_LENS_APERTURES = new Set(['f/1', 'f/1.0']);

export const isManualLensAperture = (aperture) => MANUAL_LENS_APERTURES.has(aperture);

export const setLensOverride = (overrides, key, lens) => {
  if (lens) return { overrides: { ...overrides, [key]: lens }, action: 'set' };
  if (!(key in overrides)) return { overrides, action: 'unchanged' };
  const { [key]: _, ...rest } = overrides;
  return { overrides: rest, action: 'cleared' };
};

export const photoLensFields = (exif, override) => ({
  lens: override || exif.lens || null,
  focalLength: isManualLensAperture(exif.aperture) ? null : exif.focalLength || null,
});

import exifr from 'exifr';

// The only tags the site renders. Narrowing the pick keeps the parse cheap on
// the 128KB range reads process.js does, where the tail of the file is absent.
const PICKED_TAGS = [
  'Make', 'Model', 'LensModel', 'Lens', 'LensID',
  'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'DateTimeOriginal',
];

const formatShutter = (seconds) =>
  seconds < 1 ? `1/${Math.round(1 / seconds)}s` : `${seconds}s`;

// Returns `{}` when a photo carries no EXIF, or when the buffer cannot be
// parsed at all. Callers cache that empty result deliberately: it is the
// answer "this photo has nothing to read", not a failure to retry.
export const parseExif = async (buffer) => {
  try {
    const data = await exifr.parse(buffer, { pick: PICKED_TAGS });
    if (!data) return {};

    return {
      camera: [data.Make, data.Model].filter(Boolean).join(' ').trim() || null,
      lens: data.LensModel || data.Lens || data.LensID || null,
      aperture: data.FNumber ? `f/${data.FNumber}` : null,
      shutter: data.ExposureTime ? formatShutter(data.ExposureTime) : null,
      iso: data.ISO ? `ISO ${data.ISO}` : null,
      focalLength: data.FocalLength ? `${Math.round(data.FocalLength)}mm` : null,
      dateTaken: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toISOString() : null,
    };
  } catch {
    return {};
  }
};

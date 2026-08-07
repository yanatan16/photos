export const THUMBNAIL_DIR = '.thumbnails';
export const WEB_DIR = '.web';

const DERIVED_DIRS = new Set([THUMBNAIL_DIR, WEB_DIR]);

const PHOTO_PATTERN = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?)$/i;

const derivedKey = (dir) => (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, dir, filename].join('/');
};

export const thumbnailKey = derivedKey(THUMBNAIL_DIR);
export const webKey = derivedKey(WEB_DIR);

export const originalKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  const parent = parts.pop();
  return DERIVED_DIRS.has(parent) ? [...parts, filename].join('/') : key;
};

// A photo exists if its original is in the bucket OR its web derivative is —
// uploads now write derivatives first and defer the original, so the web copy
// is what proves the photo exists. A thumbnail alone is not enough: it carries
// no EXIF and cannot stand in for the full-size view.
export const logicalPhotoKeys = (keys) => new Set(
  keys.flatMap((key) => {
    const parts = key.split('/');
    if (parts.length < 2) return [];

    const filename = parts.at(-1);
    if (filename.startsWith('.') || !PHOTO_PATTERN.test(filename)) return [];

    const parent = parts.at(-2);
    if (parent === WEB_DIR) return [originalKey(key)];
    return parent.startsWith('.') ? [] : [key];
  })
);

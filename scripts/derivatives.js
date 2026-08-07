import sharp from 'sharp';

export const THUMBNAIL_WIDTH = 600;
export const WEB_WIDTH = 2048;

const resizeTo = (width, quality, keepMetadata = false) => (buffer) => {
  const pipeline = sharp(buffer)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality });

  return (keepMetadata ? pipeline.keepMetadata() : pipeline).toBuffer();
};

export const makeThumbnail = resizeTo(THUMBNAIL_WIDTH, 80);

// EXIF is kept here and only here. When the original upload is deferred, this
// derivative is the only copy of the metadata in the bucket, and process.js
// range-reads it from exactly this file. A 600px thumbnail has no such duty.
export const makeWebSized = resizeTo(WEB_WIDTH, 85, true);

import { Upload } from '@aws-sdk/lib-storage';
import { extname } from 'path';
import { withRetry } from './retry.js';

// ── content types ─────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

// .heic/.heif are absent on purpose: this repo's sharp reads their metadata but
// cannot decode their pixels, and a photo we cannot resize is a photo we cannot
// publish now that only derivatives are uploaded up front.
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export const contentTypeFor = (filePath) =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';

// ── upload ────────────────────────────────────────────────────────────────────

// createBody is a factory, not a value, because a read stream cannot be replayed
// once consumed — a retry that reused one would silently upload a zero-byte
// object. Buffer callers can safely return the same buffer every time.
export const uploadToR2 = (client, bucketName, { key, contentType, createBody }, hooks = {}) =>
  withRetry(() => {
    hooks.onAttemptStart?.();

    const upload = new Upload({
      client,
      params: { Bucket: bucketName, Key: key, Body: createBody(), ContentType: contentType },
    });

    upload.on('httpUploadProgress', ({ loaded }) => hooks.onProgress?.(loaded ?? 0));
    return upload.done();
  }, { onRetry: hooks.onRetry });

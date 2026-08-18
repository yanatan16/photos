import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, getBucketName } from './r2client.js';
import { createJsonStore } from './jsonStore.js';

export const EXIF_CACHE_KEY = 'exif-cache.json';

export const saveExifCache = createJsonStore(EXIF_CACHE_KEY, {}).save;

export const isMissingObject = (error) =>
  error?.name === 'NoSuchKey' ||
  error?.name === 'NotFound' ||
  error?.$metadata?.httpStatusCode === 404;

// Deliberately not createJsonStore's `load`, which reports every failure as the
// empty fallback. Both callers merge their new entries onto what they read and
// write the whole object back, so a transient read failure reported as "empty"
// would erase every EXIF entry in the bucket. An absent object is empty;
// anything else throws and leaves the existing cache untouched.
export const loadExifCache = async () => {
  try {
    const response = await createS3Client().send(new GetObjectCommand({
      Bucket: getBucketName(),
      Key: EXIF_CACHE_KEY,
    }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (isMissingObject(error)) return {};
    throw error;
  }
};

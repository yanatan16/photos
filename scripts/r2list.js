import { ListObjectsV2Command } from '@aws-sdk/client-s3';

// One paginated sweep of the bucket. `prefix` is optional: omit it to list
// everything (fetch-photos, process), pass `album/` to list one album. An
// empty string is normalised to `undefined` — `r2 ls` with no argument passes
// one, and S3 should see no Prefix at all rather than an empty one.
export const listAllObjects = async (client, bucketName, prefix) => {
  const objects = [];
  let continuationToken;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }));

    if (response.Contents) objects.push(...response.Contents);
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
};

export const listAlbumKeys = async (client, bucketName, album) =>
  new Set((await listAllObjects(client, bucketName, `${album}/`)).map(object => object.Key));

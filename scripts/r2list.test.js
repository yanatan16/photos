import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAllObjects, listAlbumKeys } from './r2list.js';

// Records every command input it is handed, and replays `pages` in order —
// enough to assert both the request shape and the pagination loop.
const stubClient = (pages) => {
  const inputs = [];
  let index = 0;
  return {
    inputs,
    send: async (command) => {
      inputs.push(command.input);
      return pages[index++] ?? {};
    },
  };
};

test('listAllObjects follows continuation tokens and concatenates pages', async () => {
  const client = stubClient([
    { Contents: [{ Key: 'a.jpg' }], NextContinuationToken: 'page2' },
    { Contents: [{ Key: 'b.jpg' }] },
  ]);

  const objects = await listAllObjects(client, 'bucket');

  assert.deepEqual(objects.map(object => object.Key), ['a.jpg', 'b.jpg']);
  assert.equal(client.inputs.length, 2);
  assert.equal(client.inputs[0].ContinuationToken, undefined);
  assert.equal(client.inputs[1].ContinuationToken, 'page2');
});

test('listAllObjects passes the prefix through when given one', async () => {
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket', '2026-italy/');

  assert.equal(client.inputs[0].Prefix, '2026-italy/');
  assert.equal(client.inputs[0].Bucket, 'bucket');
});

test('listAllObjects omits the prefix when none is given', async () => {
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket');

  assert.equal(client.inputs[0].Prefix, undefined);
});

test('listAllObjects treats an empty prefix as no prefix', async () => {
  // `r2 ls` with no argument passes '', and the copy it replaces guarded
  // against sending `Prefix: ''` to S3. Keep that guard.
  const client = stubClient([{ Contents: [] }]);

  await listAllObjects(client, 'bucket', '');

  assert.equal(client.inputs[0].Prefix, undefined);
});

test('listAllObjects tolerates a page with no Contents', async () => {
  const client = stubClient([{}]);

  assert.deepEqual(await listAllObjects(client, 'bucket'), []);
});

test('listAlbumKeys returns a key set scoped to the album prefix', async () => {
  const client = stubClient([{
    Contents: [
      { Key: '2026-italy/a.jpg' },
      { Key: '2026-italy/.web/a.jpg' },
    ],
  }]);

  const keys = await listAlbumKeys(client, 'bucket', '2026-italy');

  assert.equal(client.inputs[0].Prefix, '2026-italy/');
  assert.ok(keys instanceof Set);
  assert.ok(keys.has('2026-italy/.web/a.jpg'));
  assert.equal(keys.size, 2);
});

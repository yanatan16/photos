import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObjects, albumSummary } from './fetch-photos.js';

const PUBLIC = 'https://cdn.test';

const object = (Key, LastModified = new Date('2026-01-01T00:00:00Z')) => ({ Key, LastModified });

const parse = (objects, { exif = {}, covers = {}, lenses = {} } = {}) =>
  parseObjects(objects, PUBLIC, exif, covers, lenses);

test('parseObjects builds an album from an original with both derivatives', () => {
  const [album] = parse([
    object('2026-italy/a.jpg'),
    object('2026-italy/.thumbnails/a.jpg'),
    object('2026-italy/.web/a.jpg'),
  ]);

  assert.equal(album.id, '2026-italy');
  assert.equal(album.name, 'Italy');
  assert.equal(album.year, '2026');
  assert.equal(album.photos.length, 1);
  assert.equal(album.photos[0].url, `${PUBLIC}/2026-italy/a.jpg`);
  assert.equal(album.photos[0].thumbnail, `${PUBLIC}/2026-italy/.thumbnails/a.jpg`);
  assert.equal(album.photos[0].web, `${PUBLIC}/2026-italy/.web/a.jpg`);
});

test('parseObjects includes a photo whose original is still queued locally', () => {
  const [album] = parse([
    object('2026-italy/.thumbnails/a.jpg'),
    object('2026-italy/.web/a.jpg'),
  ]);

  assert.equal(album.photos.length, 1);
  // url keeps pointing at the original key even before that object exists —
  // favorites, covers, and lens overrides are all keyed off it.
  assert.equal(album.photos[0].url, `${PUBLIC}/2026-italy/a.jpg`);
  assert.equal(album.photos[0].web, `${PUBLIC}/2026-italy/.web/a.jpg`);
});

test('parseObjects dates a deferred photo from its web derivative', () => {
  const [album] = parse([
    object('2026-italy/.web/a.jpg', new Date('2026-03-04T05:06:07Z')),
  ]);

  assert.equal(album.photos[0].date, '2026-03-04T05:06:07.000Z');
});

test('parseObjects prefers EXIF date over object modification time', () => {
  const [album] = parse([object('2026-italy/a.jpg')], {
    exif: { '2026-italy/a.jpg': { dateTaken: '2025-09-09T00:00:00.000Z', camera: 'X-T5' } },
  });

  assert.equal(album.photos[0].date, '2025-09-09T00:00:00.000Z');
  assert.equal(album.photos[0].camera, 'X-T5');
});

test('parseObjects ignores root files and non-images', () => {
  const albums = parse([
    object('exif-cache.json'),
    object('2026-italy/notes.txt'),
    object('2026-italy/a.jpg'),
  ]);

  assert.equal(albums.length, 1);
  assert.equal(albums[0].photos.length, 1);
});

test('parseObjects orders photos within an album by time, not by filename', () => {
  const [album] = parse([
    object('2026-italy/DSCF0001.jpg'),
    object('2026-italy/IMG_0001.jpg'),
    object('2026-italy/IMG_0002.jpg'),
  ], {
    exif: {
      '2026-italy/DSCF0001.jpg': { dateTaken: '2026-05-01T12:00:00.000Z' },
      '2026-italy/IMG_0001.jpg': { dateTaken: '2026-05-01T09:00:00.000Z' },
      '2026-italy/IMG_0002.jpg': { dateTaken: '2026-05-01T15:00:00.000Z' },
    },
  });

  assert.deepEqual(
    album.photos.map(photo => photo.filename),
    ['IMG_0001.jpg', 'DSCF0001.jpg', 'IMG_0002.jpg']
  );
  // The album date and default cover follow the earliest photo, not the
  // lexicographically first filename.
  assert.equal(album.firstPhotoDate, '2026-05-01T09:00:00.000Z');
  assert.equal(album.cover, `${PUBLIC}/2026-italy/IMG_0001.jpg`);
});

test('parseObjects sorts undated photos to the end of an album', () => {
  const [album] = parse([
    object('2026-italy/a.jpg', null),
    object('2026-italy/b.jpg', new Date('2026-05-01T09:00:00Z')),
  ]);

  assert.deepEqual(album.photos.map(photo => photo.filename), ['b.jpg', 'a.jpg']);
});

test('parseObjects sorts albums newest first and honours a configured cover', () => {
  const albums = parse([
    object('2025-japan/z.jpg', new Date('2025-05-01T00:00:00Z')),
    object('2025-japan/a.jpg', new Date('2025-04-01T00:00:00Z')),
    object('2026-italy/a.jpg', new Date('2026-01-01T00:00:00Z')),
  ], { covers: { '2025-japan': 'z.jpg' } });

  assert.deepEqual(albums.map(album => album.id), ['2026-italy', '2025-japan']);
  assert.equal(albums[1].cover, `${PUBLIC}/2025-japan/z.jpg`);
});

test('albumSummary keeps only what the blog homepage renders', () => {
  const albums = parse([
    object('2026-italy/a.jpg', new Date('2026-01-01T00:00:00Z')),
    object('2026-italy/b.jpg', new Date('2026-01-02T00:00:00Z')),
  ]);

  assert.deepEqual(albumSummary(albums), [{
    id: '2026-italy',
    name: 'Italy',
    count: 2,
    cover: `${PUBLIC}/2026-italy/a.jpg`,
  }]);
});

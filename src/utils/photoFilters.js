import { byDateAscending } from '../../scripts/dates.js';

export const buildItemList = (photos, keyFn) => {
  const map = new Map();
  photos.forEach(p => {
    const key = keyFn(p);
    if (!key) return;
    if (!map.has(key)) map.set(key, { count: 0, cover: p.thumbnail });
    map.get(key).count++;
  });
  return [...map.entries()]
    .map(([value, { count, cover }]) => ({ value, count, cover }))
    .sort((a, b) => b.count - a.count);
};

const getPhotosByCamera = (albums, camera) =>
  albums.flatMap(a => a.photos).filter(p => p.camera === camera);

const sortByDate = (photos) =>
  [...photos].sort((a, b) => byDateAscending(a.date, b.date));

export const getCameraList = (albums) =>
  buildItemList(albums.flatMap(a => a.photos), p => p.camera);

export const getLensListForCamera = (albums, camera) =>
  buildItemList(getPhotosByCamera(albums, camera), p => p.lens);

export const getFilteredPhotos = (albums, camera, lens) =>
  sortByDate(
    getPhotosByCamera(albums, camera).filter(p => lens === null || p.lens === lens)
  );

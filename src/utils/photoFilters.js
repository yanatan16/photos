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
  [...photos].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

export const getCameraList = (albums) =>
  buildItemList(albums.flatMap(a => a.photos), p => p.camera);

export const getLensListForCamera = (albums, camera) =>
  buildItemList(getPhotosByCamera(albums, camera), p => p.lens);

export const getFilteredPhotos = (albums, camera, lens) =>
  sortByDate(
    getPhotosByCamera(albums, camera).filter(p => lens === null || p.lens === lens)
  );

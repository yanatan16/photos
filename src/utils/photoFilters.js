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

export const getCameraList = (albums) =>
  buildItemList(albums.flatMap(a => a.photos), p => p.camera);

export const getLensListForCamera = (albums, camera) =>
  buildItemList(
    albums.flatMap(a => a.photos).filter(p => p.camera === camera),
    p => p.lens
  );

export const getFilteredPhotos = (albums, camera, lens) =>
  albums
    .flatMap(album =>
      album.photos.filter(p =>
        p.camera === camera && (lens === null || p.lens === lens)
      )
    )
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

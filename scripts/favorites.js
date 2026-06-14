export const favoriteKey = (albumSlug, filename) => `${albumSlug}/${filename}`;

export const favoriteKeyFromUrl = (url) => new URL(url).pathname.replace(/^\/+/, '');

export const toggleFavorite = (favorites, key) => {
  if (favorites.includes(key)) {
    return { favorites: favorites.filter(k => k !== key), action: 'removed' };
  }
  return { favorites: [...favorites, key], action: 'added' };
};

export const buildFavorites = (albums, favoriteKeys) => {
  const favoriteSet = new Set(favoriteKeys);
  return albums
    .flatMap(album =>
      album.photos.map(photo => ({ photo, key: favoriteKey(album.id, photo.filename) }))
    )
    .filter(({ key }) => favoriteSet.has(key))
    .map(({ photo }) => photo)
    .sort((a, b) => {
      const da = a.date ? new Date(a.date) : new Date(0);
      const db = b.date ? new Date(b.date) : new Date(0);
      return db - da;
    });
};

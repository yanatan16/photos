export const thumbnailKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.thumbnails', filename].join('/');
};

export const webKey = (key) => {
  const parts = key.split('/');
  const filename = parts.pop();
  return [...parts, '.web', filename].join('/');
};

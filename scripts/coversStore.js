import { createJsonStore } from './jsonStore.js';

export const COVERS_KEY = 'album-covers.json';

const store = createJsonStore(COVERS_KEY, {});

export const loadCovers = store.load;
export const saveCovers = store.save;

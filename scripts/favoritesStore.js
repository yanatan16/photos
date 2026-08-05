import { createJsonStore } from './jsonStore.js';

export const FAVORITES_KEY = 'favorites.json';

const store = createJsonStore(FAVORITES_KEY, []);

export const loadFavorites = store.load;
export const saveFavorites = store.save;

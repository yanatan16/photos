import { createJsonStore } from './jsonStore.js';

export const LENS_OVERRIDES_KEY = 'lens-overrides.json';

const store = createJsonStore(LENS_OVERRIDES_KEY, {});

export const loadLensOverrides = store.load;
export const saveLensOverrides = store.save;

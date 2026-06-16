import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { favoriteKeyFromUrl, albumSlugFromKey, filenameFromKey } from '../../scripts/favorites.js';

const STATE_ENDPOINT = '/__state';
const FAVORITES_ENDPOINT = '/__favorites';
const COVER_ENDPOINT = '/__cover';
const DELETE_ENDPOINT = '/__delete';

const NOOP = () => {};

const DevToolsContext = createContext(null);

const postKey = async (endpoint, key) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const DevToolsProvider = ({ children }) => {
  const [favorites, setFavorites] = useState(null); // null = not loaded
  const [covers, setCovers] = useState({});
  const [deleted, setDeleted] = useState(() => new Set());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch(STATE_ENDPOINT)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => {
        setFavorites(new Set(data.favorites));
        setCovers(data.covers ?? {});
      })
      .catch(err => console.warn('Dev tools unavailable:', err.message));
  }, []);

  const enabled = import.meta.env.DEV && favorites !== null;

  const run = useCallback(async (fn) => {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }, []);

  const toggleFavorite = useCallback((url) => run(async () => {
    try {
      const data = await postKey(FAVORITES_ENDPOINT, favoriteKeyFromUrl(url));
      setFavorites(new Set(data.favorites));
    } catch (err) {
      console.warn('Failed to toggle favorite:', err.message);
    }
  }), [run]);

  const setCover = useCallback((url) => run(async () => {
    try {
      const data = await postKey(COVER_ENDPOINT, favoriteKeyFromUrl(url));
      setCovers(data.covers ?? {});
    } catch (err) {
      console.warn('Failed to set cover:', err.message);
    }
  }), [run]);

  const deletePhoto = useCallback((url) => run(async () => {
    const key = favoriteKeyFromUrl(url);
    try {
      await postKey(DELETE_ENDPOINT, key);
      setDeleted(prev => new Set(prev).add(key));
    } catch (err) {
      console.warn('Failed to delete photo:', err.message);
    }
  }), [run]);

  const value = { enabled, pending, favorites, covers, deleted, toggleFavorite, setCover, deletePhoto };
  return <DevToolsContext.Provider value={value}>{children}</DevToolsContext.Provider>;
};

const useDevTools = () => useContext(DevToolsContext) ?? {};

export const useFavorites = () => {
  const { enabled, pending, favorites, toggleFavorite } = useDevTools();
  return useMemo(() => ({
    enabled: enabled ?? false,
    pending: pending ?? false,
    isFavorite: (url) => favorites?.has(favoriteKeyFromUrl(url)) ?? false,
    toggle: toggleFavorite ?? NOOP,
  }), [enabled, pending, favorites, toggleFavorite]);
};

export const useCovers = () => {
  const { enabled, pending, covers, setCover } = useDevTools();
  return useMemo(() => ({
    enabled: enabled ?? false,
    pending: pending ?? false,
    isCover: (url) => {
      const key = favoriteKeyFromUrl(url);
      return covers?.[albumSlugFromKey(key)] === filenameFromKey(key);
    },
    setCover: setCover ?? NOOP,
  }), [enabled, pending, covers, setCover]);
};

export const useDeletions = () => {
  const { enabled, pending, deleted, deletePhoto } = useDevTools();
  return useMemo(() => ({
    enabled: enabled ?? false,
    pending: pending ?? false,
    isDeleted: (url) => deleted?.has(favoriteKeyFromUrl(url)) ?? false,
    deletePhoto: deletePhoto ?? NOOP,
  }), [enabled, pending, deleted, deletePhoto]);
};

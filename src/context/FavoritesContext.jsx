import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { favoriteKeyFromUrl } from '../../scripts/favorites.js';

const ENDPOINT = '/__favorites';

const FavoritesContext = createContext({
  enabled: false,
  isFavorite: () => false,
  toggle: () => {},
  pending: false,
});

export const FavoritesProvider = ({ children }) => {
  const [keys, setKeys] = useState(null); // null = not loaded; Set = loaded
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch(ENDPOINT)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => setKeys(new Set(data.favorites)))
      .catch(err => console.warn('Favorites unavailable:', err.message));
  }, []);

  const enabled = import.meta.env.DEV && keys !== null;

  const isFavorite = useCallback(
    (url) => keys?.has(favoriteKeyFromUrl(url)) ?? false,
    [keys]
  );

  const toggle = useCallback(async (url) => {
    setPending(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: favoriteKeyFromUrl(url) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(new Set(data.favorites));
    } catch (err) {
      console.warn('Failed to toggle favorite:', err.message);
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <FavoritesContext.Provider value={{ enabled, isFavorite, toggle, pending }}>
      {children}
    </FavoritesContext.Provider>
  );
};

export const useFavorites = () => useContext(FavoritesContext);

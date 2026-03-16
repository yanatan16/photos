import { useState } from 'react';
import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const NAV_FILTERS = ['All', 'Camera', 'Lens'];

const formatDate = (isoDate) => {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
};

const albumField = (filter) => `${filter.toLowerCase()}s`;

const getValueCounts = (albums, filter) => {
  const counts = new Map();
  albums.forEach(album => {
    (album[albumField(filter)] || []).forEach(v => {
      counts.set(v, (counts.get(v) || 0) + 1);
    });
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

const filterAlbums = (albums, filter, value) => {
  if (!value) return albums;
  return albums.filter(album => (album[albumField(filter)] || []).includes(value));
};

const AlbumCard = ({ album }) => (
  <Link to={`/album/${album.id}`} className="album-card">
    <div className="album-cover">
      <img src={album.cover} alt={album.name} loading="lazy" />
    </div>
    <div className="album-info">
      <h2 className="album-title">
        {album.year && <span className="album-year">{album.year}</span>}
        {album.name}
      </h2>
      {album.firstPhotoDate && (
        <p className="album-date">{formatDate(album.firstPhotoDate)}</p>
      )}
      <p className="album-count">{album.photos.length} photos</p>
    </div>
  </Link>
);

const ValuePicker = ({ filter, albums, onSelect }) => {
  const values = getValueCounts(albums, filter);

  if (values.length === 0) {
    return (
      <div className="filter-empty-state">
        <p>No {filter.toLowerCase()} data yet.</p>
        <p className="filter-empty-hint">Run <code>npm run extract-exif</code> to extract photo metadata.</p>
      </div>
    );
  }

  return (
    <div className="value-picker">
      {values.map(([value, count]) => (
        <button key={value} className="value-chip" onClick={() => onSelect(value)}>
          <span className="value-name">{value}</span>
          <span className="value-count">{count} album{count !== 1 ? 's' : ''}</span>
        </button>
      ))}
    </div>
  );
};

const AlbumGrid = ({ albums }) => {
  const [activeFilter, setActiveFilter] = useState('All');
  const [activeValue, setActiveValue] = useState(null);

  const setFilter = (filter) => {
    setActiveFilter(filter);
    setActiveValue(null);
  };

  const visibleAlbums = filterAlbums(albums, activeFilter, activeValue);

  return (
    <div className="album-grid-container">
      <header className="album-header">
        <h1>Photos by Jon Eisen</h1>
        <a href="https://joneisen.me" className="blog-link">← joneisen.me</a>
      </header>

      <nav className="album-nav">
        {NAV_FILTERS.map(filter => (
          <button
            key={filter}
            className={`nav-tab${activeFilter === filter ? ' active' : ''}`}
            onClick={() => setFilter(filter)}
          >
            {filter}
          </button>
        ))}
      </nav>

      {activeFilter !== 'All' && !activeValue ? (
        <ValuePicker filter={activeFilter} albums={albums} onSelect={setActiveValue} />
      ) : (
        <>
          {activeValue && (
            <div className="filter-breadcrumb">
              <button className="breadcrumb-back" onClick={() => setActiveValue(null)}>
                ← {activeFilter}
              </button>
              <span className="breadcrumb-value">{activeValue}</span>
            </div>
          )}
          <div className="album-grid">
            {visibleAlbums.map(album => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default AlbumGrid;

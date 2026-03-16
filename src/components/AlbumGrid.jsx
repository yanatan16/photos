import { useState } from 'react';
import { Link } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
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

const getFilteredPhotos = (albums, filter, value) => {
  const field = filter.toLowerCase();
  return albums
    .flatMap(album => album.photos.filter(p => p[field] === value))
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });
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

const FilteredPhotoGrid = ({ filter, value, albums, onBack }) => {
  const [selectedIndex, setSelectedIndex] = useState(null);
  const photos = getFilteredPhotos(albums, filter, value);

  return (
    <>
      <div className="filter-breadcrumb">
        <button className="breadcrumb-back" onClick={onBack}>← {filter}</button>
        <span className="breadcrumb-value">{value}</span>
        <span className="breadcrumb-count">{photos.length} photos</span>
      </div>
      <div className="photo-grid">
        {photos.map((photo, index) => (
          <button
            key={`${photo.url}-${index}`}
            className="photo-card"
            onClick={() => setSelectedIndex(index)}
          >
            <img src={photo.thumbnail} alt={photo.filename} loading="lazy" />
          </button>
        ))}
      </div>
      {selectedIndex !== null && (
        <PhotoViewer
          photos={photos}
          currentIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
          onNavigate={setSelectedIndex}
        />
      )}
    </>
  );
};

const AlbumGrid = ({ albums }) => {
  const [activeFilter, setActiveFilter] = useState('All');
  const [activeValue, setActiveValue] = useState(null);

  const setFilter = (filter) => {
    setActiveFilter(filter);
    setActiveValue(null);
  };

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

      {activeFilter === 'All' && (
        <div className="album-grid">
          {albums.map(album => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      )}

      {activeFilter !== 'All' && !activeValue && (
        <ValuePicker filter={activeFilter} albums={albums} onSelect={setActiveValue} />
      )}

      {activeFilter !== 'All' && activeValue && (
        <FilteredPhotoGrid
          filter={activeFilter}
          value={activeValue}
          albums={albums}
          onBack={() => setActiveValue(null)}
        />
      )}
    </div>
  );
};

export default AlbumGrid;

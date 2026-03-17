import { useState } from 'react';
import { Link } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
import './AlbumGrid.css';

const formatDate = (isoDate) => {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
};

const buildItemList = (photos, keyFn) => {
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

const getCameraList = (albums) =>
  buildItemList(albums.flatMap(a => a.photos), p => p.camera);

const getLensListForCamera = (albums, camera) =>
  buildItemList(
    albums.flatMap(a => a.photos).filter(p => p.camera === camera),
    p => p.lens
  );

const getFilteredPhotos = (albums, camera, lens) =>
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

const CoverGrid = ({ items, emptyMessage, onSelect }) => {
  if (items.length === 0) {
    return (
      <div className="filter-empty-state">
        <p>{emptyMessage}</p>
        <p className="filter-empty-hint">Run <code>npm run extract-exif</code> to extract photo metadata.</p>
      </div>
    );
  }
  return (
    <div className="album-grid">
      {items.map(({ value, count, cover }) => (
        <button key={value} className="album-card cover-card" onClick={() => onSelect(value)}>
          <div className="album-cover">
            {cover && <img src={cover} alt={value} loading="lazy" />}
          </div>
          <div className="album-info">
            <h2 className="album-title">{value}</h2>
            <p className="album-count">{count} photo{count !== 1 ? 's' : ''}</p>
          </div>
        </button>
      ))}
    </div>
  );
};

const FilteredPhotoGrid = ({ camera, lens, albums, onBack }) => {
  const [selectedIndex, setSelectedIndex] = useState(null);
  const photos = getFilteredPhotos(albums, camera, lens);

  return (
    <>
      <div className="filter-breadcrumb">
        <button className="breadcrumb-back" onClick={onBack}>← {lens ? camera : 'Camera'}</button>
        <span className="breadcrumb-value">{lens ?? camera}</span>
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

const CameraView = ({ albums, onBack }) => {
  const [activeCamera, setActiveCamera] = useState(null);
  const [activeLens, setActiveLens] = useState(null);

  if (activeCamera && activeLens !== undefined) {
    // activeLens === null means "all lenses for this camera"
    return (
      <FilteredPhotoGrid
        camera={activeCamera}
        lens={activeLens}
        albums={albums}
        onBack={() => setActiveLens(undefined)}
      />
    );
  }

  if (activeCamera) {
    const lenses = getLensListForCamera(albums, activeCamera);
    const totalPhotos = getFilteredPhotos(albums, activeCamera, null).length;
    const allLensesItem = { value: 'All lenses', count: totalPhotos, cover: lenses[0]?.cover };
    return (
      <>
        <div className="filter-breadcrumb">
          <button className="breadcrumb-back" onClick={() => setActiveCamera(null)}>← Camera</button>
          <span className="breadcrumb-value">{activeCamera}</span>
        </div>
        <CoverGrid
          items={[allLensesItem, ...lenses]}
          emptyMessage="No lens data for this camera."
          onSelect={(v) => setActiveLens(v === 'All lenses' ? null : v)}
        />
      </>
    );
  }

  return (
    <CoverGrid
      items={getCameraList(albums)}
      emptyMessage="No camera data yet."
      onSelect={setActiveCamera}
    />
  );
};

const AlbumGrid = ({ albums }) => {
  const [activeFilter, setActiveFilter] = useState('All');

  return (
    <div className="album-grid-container">
      <header className="album-header">
        <h1>Photos by Jon Eisen</h1>
        <a href="https://joneisen.me" className="blog-link">← joneisen.me</a>
      </header>

      <nav className="album-nav">
        {['All', 'Camera'].map(filter => (
          <button
            key={filter}
            className={`nav-tab${activeFilter === filter ? ' active' : ''}`}
            onClick={() => setActiveFilter(filter)}
          >
            {filter}
          </button>
        ))}
      </nav>

      {activeFilter === 'All' ? (
        <div className="album-grid">
          {albums.map(album => <AlbumCard key={album.id} album={album} />)}
        </div>
      ) : (
        <CameraView albums={albums} />
      )}
    </div>
  );
};

export default AlbumGrid;

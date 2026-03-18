import { Link } from 'react-router-dom';
import { getCameraList } from '../utils/photoFilters';
import './AlbumGrid.css';

const CameraGrid = ({ albums }) => {
  const cameras = getCameraList(albums);

  if (cameras.length === 0) {
    return (
      <div className="filter-empty-state">
        <p>No camera data yet.</p>
        <p className="filter-empty-hint">Run <code>npm run extract-exif</code> to extract photo metadata.</p>
      </div>
    );
  }

  return (
    <div className="album-grid">
      {cameras.map(({ value, count, cover }) => (
        <Link
          key={value}
          to={`/camera/${encodeURIComponent(value)}`}
          className="album-card cover-card"
        >
          <div className="album-cover">
            {cover && <img src={cover} alt={value} loading="lazy" />}
          </div>
          <div className="album-info">
            <h2 className="album-title">{value}</h2>
            <p className="album-count">{count} photo{count !== 1 ? 's' : ''}</p>
          </div>
        </Link>
      ))}
    </div>
  );
};

export default CameraGrid;

import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const formatDate = (isoDate) => {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
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

export default AlbumCard;

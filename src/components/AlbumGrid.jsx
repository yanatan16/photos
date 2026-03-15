import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const AlbumGrid = ({ albums }) => {
  return (
    <div className="album-grid-container">
      <header className="album-header">
        <h1>Photos by Jon Eisen</h1>
        <a href="https://joneisen.me" className="blog-link">← joneisen.me</a>
      </header>
      <div className="album-grid">
        {albums.map(album => (
          <Link
            key={album.id}
            to={`/album/${album.id}`}
            className="album-card"
          >
            <div className="album-cover">
              <img
                src={album.cover}
                alt={album.name}
                loading="lazy"
              />
            </div>
            <div className="album-info">
              <h2 className="album-title">{album.name}</h2>
              <p className="album-count">{album.photos.length} photos</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default AlbumGrid;

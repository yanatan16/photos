import { useParams, Link } from 'react-router-dom';
import PhotoGrid from './PhotoGrid';
import './PhotoGallery.css';

const PhotoGallery = ({ albums }) => {
  const { albumId } = useParams();
  const album = albums.find(a => a.id === albumId);

  if (!album) {
    return (
      <div className="photo-gallery-container">
        <div className="error-message">Album not found</div>
        <Link to="/" className="back-button">← Back to Albums</Link>
      </div>
    );
  }

  return (
    <div className="photo-gallery-container">
      <header className="gallery-header">
        <Link to="/" className="back-button">← Back to Albums</Link>
        <h1 className="gallery-title">{album.name}</h1>
        <p className="gallery-count">{album.photos.length} photos</p>
      </header>
      <PhotoGrid photos={album.photos} />
    </div>
  );
};

export default PhotoGallery;

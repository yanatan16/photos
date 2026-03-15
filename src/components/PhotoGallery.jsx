import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
import './PhotoGallery.css';

const findAlbum = (albums, albumId) => {
  return albums.find(album => album.id === albumId);
};

const PhotoGallery = ({ albums }) => {
  const { albumId } = useParams();
  const album = findAlbum(albums, albumId);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(null);

  if (!album) {
    return (
      <div className="photo-gallery-container">
        <div className="error-message">Album not found</div>
        <Link to="/" className="back-button">← Back to Albums</Link>
      </div>
    );
  }

  const openPhoto = (index) => {
    setSelectedPhotoIndex(index);
  };

  const closePhoto = () => {
    setSelectedPhotoIndex(null);
  };

  return (
    <div className="photo-gallery-container">
      <header className="gallery-header">
        <Link to="/" className="back-button">← Back to Albums</Link>
        <h1 className="gallery-title">{album.name}</h1>
        <p className="gallery-count">{album.photos.length} photos</p>
      </header>

      <div className="photo-grid">
        {album.photos.map((photo, index) => (
          <button
            key={index}
            className="photo-card"
            onClick={() => openPhoto(index)}
          >
            <img
              src={photo.thumbnail}
              alt={photo.filename}
              loading="lazy"
            />
          </button>
        ))}
      </div>

      {selectedPhotoIndex !== null && (
        <PhotoViewer
          photos={album.photos}
          currentIndex={selectedPhotoIndex}
          onClose={closePhoto}
          onNavigate={setSelectedPhotoIndex}
        />
      )}
    </div>
  );
};

export default PhotoGallery;

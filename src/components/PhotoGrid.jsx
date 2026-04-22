import { useSearchParams } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
import './PhotoGrid.css';

const PhotoGrid = ({ photos }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const photoParam = searchParams.get('photo');
  const selectedIndex = photoParam !== null ? parseInt(photoParam, 10) : null;

  const openPhoto = (index) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('photo', index);
    return next;
  });

  const closePhoto = () => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.delete('photo');
    return next;
  });

  return (
    <>
      <div className="photo-grid">
        {photos.map((photo, index) => (
          <button
            key={photo.url}
            className="photo-card"
            onClick={() => openPhoto(index)}
          >
            <img src={photo.thumbnail} alt={photo.filename} loading="lazy" />
          </button>
        ))}
      </div>
      {selectedIndex !== null && (
        <PhotoViewer
          photos={photos}
          currentIndex={selectedIndex}
          onClose={closePhoto}
          onNavigate={openPhoto}
        />
      )}
    </>
  );
};

export default PhotoGrid;

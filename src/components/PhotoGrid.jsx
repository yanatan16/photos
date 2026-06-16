import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import PhotoViewer from './PhotoViewer';
import { useDeletions } from '../context/DevToolsContext';
import './PhotoGrid.css';

const PhotoGrid = ({ photos }) => {
  const { isDeleted } = useDeletions();
  const visible = useMemo(
    () => photos.filter(photo => !isDeleted(photo.url)),
    [photos, isDeleted]
  );

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
        {visible.map((photo, index) => (
          <button
            key={photo.url}
            className="photo-card"
            onClick={() => openPhoto(index)}
          >
            <img src={photo.thumbnail} alt={photo.filename} loading="lazy" />
          </button>
        ))}
      </div>
      {selectedIndex !== null && selectedIndex < visible.length && (
        <PhotoViewer
          photos={visible}
          currentIndex={selectedIndex}
          onClose={closePhoto}
          onNavigate={openPhoto}
        />
      )}
    </>
  );
};

export default PhotoGrid;

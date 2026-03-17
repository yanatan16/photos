import { useState } from 'react';
import PhotoViewer from './PhotoViewer';
import './PhotoGrid.css';

const PhotoGrid = ({ photos }) => {
  const [selectedIndex, setSelectedIndex] = useState(null);

  return (
    <>
      <div className="photo-grid">
        {photos.map((photo, index) => (
          <button
            key={photo.url}
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

export default PhotoGrid;

import { useEffect } from 'react';
import './PhotoViewer.css';

const EXIF_FIELDS = [
  { key: 'camera', primary: true },
  { key: 'lens' },
  { key: 'focalLength' },
  { key: 'aperture' },
  { key: 'shutter' },
  { key: 'iso' },
];

const ExifStrip = ({ photo }) => {
  const fields = EXIF_FIELDS.filter(f => photo[f.key]);
  if (fields.length === 0) return null;
  return (
    <div className="viewer-exif">
      {fields.map(({ key, primary }) => (
        <span key={key} className={`exif-item${primary ? '' : ' exif-secondary'}`}>
          {photo[key]}
        </span>
      ))}
    </div>
  );
};

const PhotoViewer = ({ photos, currentIndex, onClose, onNavigate }) => {
  const currentPhoto = photos[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === photos.length - 1;

  const goToPrevious = () => {
    if (!isFirst) {
      onNavigate(currentIndex - 1);
    }
  };

  const goToNext = () => {
    if (!isLast) {
      onNavigate(currentIndex + 1);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowLeft') {
      goToPrevious();
    } else if (e.key === 'ArrowRight') {
      goToNext();
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="photo-viewer-overlay" onClick={handleBackdropClick}>
      <button className="viewer-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="viewer-content">
        <button
          className="viewer-nav viewer-nav-left"
          onClick={goToPrevious}
          disabled={isFirst}
          aria-label="Previous photo"
        >
          ‹
        </button>

        <div className="viewer-image-container">
          <img
            src={currentPhoto.url}
            alt={currentPhoto.filename}
            className="viewer-image"
          />
          <div className="viewer-info">
            <span className="viewer-filename">{currentPhoto.filename}</span>
            <span className="viewer-counter">
              {currentIndex + 1} / {photos.length}
            </span>
          </div>
          <ExifStrip photo={currentPhoto} />
        </div>

        <button
          className="viewer-nav viewer-nav-right"
          onClick={goToNext}
          disabled={isLast}
          aria-label="Next photo"
        >
          ›
        </button>
      </div>
    </div>
  );
};

export default PhotoViewer;

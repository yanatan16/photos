import { useEffect } from 'react';
import './PhotoViewer.css';
import { useFavorites } from '../context/DevToolsContext';

const EXIF_FIELDS = [
  { key: 'camera', primary: true },
  { key: 'lens' },
  { key: 'focalLength' },
  { key: 'aperture' },
  { key: 'shutter' },
  { key: 'iso' },
];

const HeartIcon = ({ filled }) => (
  <svg
    className="viewer-favorite-icon"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
);

const ChevronIcon = ({ direction }) => (
  <svg
    className="viewer-nav-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {direction === 'left' ? (
      <polyline points="15 6 9 12 15 18" />
    ) : (
      <polyline points="9 6 15 12 9 18" />
    )}
  </svg>
);

const CloseIcon = () => (
  <svg
    className="viewer-close-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
);

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
  const { enabled, isFavorite, toggle, pending } = useFavorites();
  const favorited = isFavorite(currentPhoto.url);
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
        <CloseIcon />
      </button>

      <div className="viewer-content">
        <button
          className="viewer-nav viewer-nav-left"
          onClick={goToPrevious}
          disabled={isFirst}
          aria-label="Previous photo"
        >
          <ChevronIcon direction="left" />
        </button>

        <div className="viewer-image-container">
          <img
            src={currentPhoto.web || currentPhoto.url}
            alt={currentPhoto.filename}
            className="viewer-image"
          />
          <div className="viewer-info">
            <span className="viewer-filename">{currentPhoto.filename}</span>
            <span className="viewer-counter">
              {currentIndex + 1} / {photos.length}
            </span>
            <a
              href={currentPhoto.url}
              download={currentPhoto.filename}
              className="viewer-download"
              aria-label="Download original"
            >
              ↓
            </a>
            {enabled && (
              <button
                className={`viewer-favorite${favorited ? ' is-favorite' : ''}`}
                onClick={() => toggle(currentPhoto.url)}
                disabled={pending}
                aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
              >
                <HeartIcon filled={favorited} />
              </button>
            )}
          </div>
          <ExifStrip photo={currentPhoto} />
        </div>

        <button
          className="viewer-nav viewer-nav-right"
          onClick={goToNext}
          disabled={isLast}
          aria-label="Next photo"
        >
          <ChevronIcon direction="right" />
        </button>
      </div>
    </div>
  );
};

export default PhotoViewer;

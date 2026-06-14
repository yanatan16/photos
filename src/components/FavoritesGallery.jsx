import PhotoGrid from './PhotoGrid';
import './PhotoGallery.css';

const FavoritesGallery = ({ favorites }) => (
  <div className="photo-gallery-container">
    <header className="gallery-header">
      <h1 className="gallery-title">Favorites</h1>
      <p className="gallery-count">{favorites.length} photos</p>
    </header>
    {favorites.length === 0
      ? <p className="error-message">No favorites yet</p>
      : <PhotoGrid photos={favorites} />}
  </div>
);

export default FavoritesGallery;

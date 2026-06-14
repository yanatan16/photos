import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import AlbumGrid from './components/AlbumGrid';
import CameraGrid from './components/CameraGrid';
import CameraPhotos from './components/CameraPhotos';
import PhotoGallery from './components/PhotoGallery';
import FavoritesGallery from './components/FavoritesGallery';
import photosData from './data/photos.json';

const albums = photosData.albums;
const favorites = photosData.favorites ?? [];

const App = () => (
  <HashRouter>
    <div className="app">
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<AlbumGrid albums={albums} />} />
          <Route path="/favorites" element={<FavoritesGallery favorites={favorites} />} />
          <Route path="/camera" element={<CameraGrid albums={albums} />} />
          <Route path="/camera/:cameraSlug" element={<CameraPhotos albums={albums} />} />
        </Route>
        <Route path="/album/:albumId" element={<PhotoGallery albums={albums} />} />
      </Routes>
    </div>
  </HashRouter>
);

export default App;

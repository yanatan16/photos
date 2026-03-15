import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AlbumGrid from './components/AlbumGrid';
import PhotoGallery from './components/PhotoGallery';
import photosData from './data/photos.json';

const App = () => {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <div className="app">
        <Routes>
          <Route path="/" element={<AlbumGrid albums={photosData.albums} />} />
          <Route path="/album/:albumId" element={<PhotoGallery albums={photosData.albums} />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
};

export default App;

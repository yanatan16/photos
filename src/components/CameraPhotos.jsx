import { useMemo } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { getLensListForCamera, getFilteredPhotos } from '../utils/photoFilters';
import PhotoGrid from './PhotoGrid';
import './AlbumGrid.css';

const CameraPhotos = ({ albums }) => {
  const { cameraSlug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const camera = decodeURIComponent(cameraSlug);
  const activeLens = searchParams.get('lens');

  const lenses = useMemo(() => getLensListForCamera(albums, camera), [albums, camera]);
  const photos = useMemo(() => getFilteredPhotos(albums, camera, activeLens), [albums, camera, activeLens]);

  const toggleLens = (lens) =>
    setSearchParams(activeLens === lens ? {} : { lens });

  return (
    <>
      <div className="filter-breadcrumb">
        <Link to="/camera" className="breadcrumb-back">← Camera</Link>
        <span className="breadcrumb-value">{camera}</span>
        <span className="breadcrumb-count">{photos.length} photos</span>
      </div>

      {lenses.length > 0 && (
        <div className="lens-tokens">
          {lenses.map(({ value, count }) => (
            <button
              key={value}
              className={`lens-token${activeLens === value ? ' active' : ''}`}
              onClick={() => toggleLens(value)}
            >
              {value}
              <span className="lens-token-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      <PhotoGrid photos={photos} />
    </>
  );
};

export default CameraPhotos;

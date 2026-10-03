import AlbumCard from './AlbumCard';
import './AlbumGrid.css';

const AlbumGrid = ({ albums }) => (
  <div className="album-grid">
    {albums.map(album => <AlbumCard key={album.id} album={album} />)}
  </div>
);

export default AlbumGrid;

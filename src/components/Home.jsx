import AlbumCard from './AlbumCard';
import PhotoGrid from './PhotoGrid';
import SectionHeader from './SectionHeader';
import { latest } from '../utils/latest';
import './AlbumGrid.css';

const FAVORITES_SHOWN = 8;
const ALBUMS_SHOWN = 4;

const Home = ({ albums, favorites }) => (
  <>
    {favorites.length > 0 && (
      <section className="home-section">
        <SectionHeader title="Favorites" to="/favorites" linkText="See all →" />
        <PhotoGrid photos={latest(favorites, FAVORITES_SHOWN)} />
      </section>
    )}
    <section className="home-section">
      <SectionHeader title="Latest albums" to="/albums" linkText="All albums →" />
      <div className="album-grid">
        {latest(albums, ALBUMS_SHOWN).map(album => <AlbumCard key={album.id} album={album} />)}
      </div>
    </section>
  </>
);

export default Home;

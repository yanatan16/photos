import { NavLink, Outlet } from 'react-router-dom';
import './AlbumGrid.css';
import { LICENSE_NAME, LICENSE_URL } from '../license';

const NavTab = ({ to, end, children }) => (
  <NavLink to={to} end={end} className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`}>
    {children}
  </NavLink>
);

const Layout = () => (
  <div className="album-grid-container">
    <header className="album-header">
      <h1>Photos by Jon Eisen</h1>
      <a href="https://joneisen.me" className="blog-link">← joneisen.me</a>
    </header>
    <nav className="album-nav">
      <NavTab to="/" end>All</NavTab>
      <NavTab to="/favorites">Favorites</NavTab>
      <NavTab to="/camera">Camera</NavTab>
    </nav>
    <Outlet />
    <footer className="site-footer">
      <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
        {LICENSE_NAME}
      </a>
      {' '}© {new Date().getFullYear()} Jon Eisen
    </footer>
  </div>
);

export default Layout;

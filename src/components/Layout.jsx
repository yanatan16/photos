import { NavLink, Outlet } from 'react-router-dom';
import './AlbumGrid.css';

const Layout = () => (
  <div className="album-grid-container">
    <header className="album-header">
      <h1>Photos by Jon Eisen</h1>
      <a href="https://joneisen.me" className="blog-link">← joneisen.me</a>
    </header>
    <nav className="album-nav">
      <NavLink to="/" end className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`}>
        All
      </NavLink>
      <NavLink to="/camera" className={({ isActive }) => `nav-tab${isActive ? ' active' : ''}`}>
        Camera
      </NavLink>
    </nav>
    <Outlet />
  </div>
);

export default Layout;

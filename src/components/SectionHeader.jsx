import { Link } from 'react-router-dom';
import './AlbumGrid.css';

const SectionHeader = ({ title, to, linkText }) => (
  <div className="section-header">
    <h2 className="section-title">{title}</h2>
    <Link to={to} className="section-link">{linkText}</Link>
  </div>
);

export default SectionHeader;

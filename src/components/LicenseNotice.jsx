import './LicenseNotice.css';
import { LICENSE_NAME, LICENSE_URL } from '../license';

const INSTAGRAM_HANDLE = '@mildly_athletic';
const INSTAGRAM_URL = 'https://www.instagram.com/mildly_athletic/';
const LICENSE_EMAIL = 'jon.m.eisen@gmail.com';

const LicenseNotice = ({ onContinue, onCancel }) => (
  <div
    className="license-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="license-title"
    onClick={e => e.target === e.currentTarget && onCancel()}
  >
    <div className="license-modal">
      <h2 id="license-title">Before you download</h2>
      <p>
        These photos are licensed under{' '}
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">{LICENSE_NAME}</a>:
      </p>
      <ul>
        <li>Free for <strong>personal use</strong>, with credit.</li>
        <li>No modifications (ND) and no commercial use (NC). For a commercial license,{' '}
          <a href={`mailto:${LICENSE_EMAIL}`}>email me</a>.</li>
        <li>If you share it on social media, please credit me:{' '}
          <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer">{INSTAGRAM_HANDLE}</a>.</li>
      </ul>
      <div className="license-actions">
        <button className="license-cancel" onClick={onCancel}>Cancel</button>
        <button className="license-continue" onClick={onContinue} autoFocus>
          I agree, download
        </button>
      </div>
    </div>
  </div>
);

export default LicenseNotice;

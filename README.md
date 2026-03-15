# Photo Albums Website

A static React-based photo album website that displays photos stored in Cloudflare R2, with automated builds via GitHub Actions.

## Features

- 📸 Display photos organized in albums from Cloudflare R2
- 🎨 Clean, minimal dark-themed design
- 📱 Fully responsive (mobile-first)
- ⌨️ Keyboard navigation in photo viewer (arrow keys, escape)
- 🚀 Automated builds and deployment to GitHub Pages
- ⚡ Fast static site with Vite + React

## Architecture

- **Frontend:** Vite + React + React Router
- **Storage:** Cloudflare R2 (S3-compatible object storage)
- **Build:** Node.js script fetches photo metadata from R2
- **CI/CD:** GitHub Actions
- **Deployment:** GitHub Pages

## Setup

### Prerequisites

- Node.js 20+
- Cloudflare R2 bucket with public access
- GitHub repository

### Local Development

1. Clone the repository:
   ```bash
   git clone <your-repo-url>
   cd photos.joneisen.me
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file with your R2 credentials:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your R2 details:
   ```
   R2_ACCOUNT_ID=your_account_id
   R2_ACCESS_KEY_ID=your_access_key_id
   R2_SECRET_ACCESS_KEY=your_secret_access_key
   R2_BUCKET_NAME=your_bucket_name
   R2_PUBLIC_URL=https://your-bucket.public.r2.dev
   ```

5. Fetch photos from R2:
   ```bash
   npm run build:photos
   ```

6. Start the development server:
   ```bash
   npm run dev
   ```

### GitHub Actions Setup

1. Add the following secrets to your GitHub repository (Settings > Secrets and variables > Actions):
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`
   - `R2_PUBLIC_URL`

2. Enable GitHub Pages in your repository settings:
   - Go to Settings > Pages
   - Source: GitHub Actions

3. Push to `main` branch or manually trigger the workflow to deploy

## Adding Photos

### Organizing Photos in R2

Photos should be organized in folders in your R2 bucket:

```
my-bucket/
  ├── vacation-2024/
  │   ├── photo1.jpg
  │   ├── photo2.jpg
  │   └── photo3.jpg
  ├── family-photos/
  │   ├── img1.jpg
  │   └── img2.jpg
  └── nature/
      ├── landscape1.jpg
      └── landscape2.jpg
```

- Each folder becomes an album
- Folder names with dashes are converted to readable titles (e.g., `vacation-2024` → `Vacation 2024`)
- The first photo in each folder is used as the album cover
- Files in the root of the bucket are ignored

### Uploading Photos

You can upload photos to R2 using:

1. **Cloudflare Dashboard:** Web interface for manual uploads
2. **Rclone:** Command-line tool for bulk uploads
3. **AWS CLI:** Using S3-compatible API
4. **Wrangler:** Cloudflare's CLI tool

Example with rclone:
```bash
rclone copy ./my-photos/ r2:my-bucket/vacation-2024/
```

### Triggering a Rebuild

After uploading new photos:

1. **Automatic:** Push any change to the `main` branch
2. **Manual:** Go to Actions tab in GitHub > Build and Deploy > Run workflow

## Project Structure

```
photos.joneisen.me/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions workflow
├── scripts/
│   └── fetch-photos.js         # R2 metadata fetcher
├── src/
│   ├── components/
│   │   ├── AlbumGrid.jsx       # Album grid view
│   │   ├── AlbumGrid.css
│   │   ├── PhotoGallery.jsx    # Photo gallery view
│   │   ├── PhotoGallery.css
│   │   ├── PhotoViewer.jsx     # Photo lightbox viewer
│   │   └── PhotoViewer.css
│   ├── data/
│   │   └── photos.json         # Generated photo metadata
│   ├── App.jsx                 # Main app with routing
│   ├── main.jsx                # Entry point
│   └── index.css               # Global styles
├── index.html                  # HTML template
├── vite.config.js              # Vite configuration
├── package.json                # Dependencies and scripts
└── README.md                   # This file
```

## Scripts

- `npm run dev` - Start development server
- `npm run build:photos` - Fetch photo metadata from R2
- `npm run build:site` - Build static site with Vite
- `npm run build` - Run both build steps
- `npm run preview` - Preview production build locally

## Environment Variables

### Required for Development and CI/CD

| Variable | Description | Example |
|----------|-------------|---------|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID | `abc123def456` |
| `R2_ACCESS_KEY_ID` | R2 API token access key | `your_access_key` |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | `your_secret_key` |
| `R2_BUCKET_NAME` | Name of your R2 bucket | `my-photos` |
| `R2_PUBLIC_URL` | Public URL for your R2 bucket | `https://pub-xxx.r2.dev` |

### Getting R2 Credentials

1. Go to Cloudflare Dashboard > R2
2. Select your bucket
3. Create an API token with read permissions
4. Note your account ID from the URL or dashboard
5. Enable public access for your bucket and note the public URL

## Customization

### Changing the Base Path

If deploying to a custom domain instead of GitHub Pages subdirectory, update `vite.config.js`:

```javascript
export default defineConfig({
  base: '/', // For custom domain
  // or
  base: '/your-repo-name/', // For GitHub Pages
})
```

### Styling

All styles are in individual CSS files next to components. The design uses:
- Dark theme (`#0a0a0a` background)
- System fonts
- CSS Grid for responsive layouts
- Simple hover effects and transitions

## Performance

- Images are lazy-loaded
- React Router for client-side navigation
- Optimized Vite build
- Static site generation for fast loading

## Future Enhancements

- Thumbnail generation (R2 Image Resizing)
- EXIF data display
- Search and filter
- Download button
- Photo captions from metadata
- Multiple theme options

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.

# Quick Start Guide

## First Time Setup

### 1. Set up R2 Bucket

1. Create a Cloudflare R2 bucket
2. Enable public access on the bucket
3. Create an API token with read permissions
4. Note your:
   - Account ID
   - Access Key ID
   - Secret Access Key
   - Bucket name
   - Public URL

### 2. Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env with your R2 credentials
# Then fetch photos
npm run build:photos

# Start dev server
npm run dev
```

### 3. Deploy to GitHub Pages

```bash
# Create GitHub repository
gh repo create photos.joneisen.me --public --source=. --remote=origin

# Add GitHub secrets (do this via GitHub UI or CLI)
gh secret set R2_ACCOUNT_ID
gh secret set R2_ACCESS_KEY_ID
gh secret set R2_SECRET_ACCESS_KEY
gh secret set R2_BUCKET_NAME
gh secret set R2_PUBLIC_URL

# Push to GitHub
git branch -M main
git commit -m "Initial commit

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push -u origin main
```

### 4. Enable GitHub Pages

1. Go to repository Settings > Pages
2. Source: GitHub Actions
3. Wait for the workflow to complete
4. Visit your site at `https://yourusername.github.io/photos.joneisen.me/`

## Adding Photos

1. Upload photos to R2 in folders:
   ```
   my-bucket/
     ├── album-name-1/
     │   ├── photo1.jpg
     │   └── photo2.jpg
     └── album-name-2/
         └── photo3.jpg
   ```

2. Trigger rebuild:
   - Push any change to `main` branch, OR
   - Go to Actions > Build and Deploy > Run workflow

## Testing Locally

```bash
# Fetch latest photos from R2
npm run build:photos

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Troubleshooting

### Build fails in GitHub Actions
- Check that all secrets are set correctly
- Verify R2 credentials have read access
- Check GitHub Actions logs for specific errors

### Photos not showing up
- Verify photos are in folders (not root of bucket)
- Check R2 bucket has public access enabled
- Confirm R2_PUBLIC_URL is correct
- Run `npm run build:photos` and check `src/data/photos.json`

### Site not loading on GitHub Pages
- Verify GitHub Pages is enabled (Settings > Pages)
- Check that `base` in `vite.config.js` matches your repository name
- Wait a few minutes after deployment completes

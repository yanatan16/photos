import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { favoritesDevPlugin } from './scripts/favoritesDevServer.js'

export default defineConfig({
  plugins: [react(), favoritesDevPlugin()],
  base: '/photos/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
})

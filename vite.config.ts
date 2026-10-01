import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// All runtime assets (JS, CSS, fonts, worklets, icons) are bundled and precached.
// Nothing is fetched from the network at runtime.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      // The rename to Omni Song changes only what people see. The install identity
      // (start_url and scope, no explicit id), the manifest and service-worker file
      // names and the cache stay the same, so existing installs and offline copies
      // update in place and keep their projects.
      manifest: {
        name: 'Omni Song',
        short_name: 'Omni Song',
        description: 'Make electronic music in your browser. Runs entirely on your device.',
        theme_color: '#e9e5dc',
        background_color: '#e9e5dc',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,woff,png,svg,webmanifest,json}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173 },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** The app's version (package.json), shown in Help → About and on the Welcome card. */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * The built page names its version: `<meta name="omni-song-version" content="X.Y.Z">`.
 * The launchers read it to tell whether a copy already running is this version.
 */
function versionMeta(): Plugin {
  return {
    name: 'omni-song-version-meta',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'omni-song-version', content: version }, injectTo: 'head' }],
  };
}

/**
 * How a new version takes over from the one already installed (public/sw-takeover.js,
 * imported by the generated sw.js; see src/app/pwa.ts). Its address carries a hash of
 * its content, so a changed script is never taken from the browser's HTTP cache, and
 * a change to it alone still makes sw.js new.
 */
const TAKEOVER = 'sw-takeover.js';
const takeoverHash = createHash('sha256').update(readFileSync(new URL(`./public/${TAKEOVER}`, import.meta.url))).digest('hex').slice(0, 12);

// All runtime assets (JS, CSS, fonts, worklets, icons) are bundled and precached.
// Nothing is fetched from the network at runtime.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    versionMeta(),
    VitePWA({
      // 'prompt' keeps the Update button (⋯ menu) for a page in use; otherwise a new
      // version takes over by itself (public/sw-takeover.js).
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
        // Loaded by sw.js itself, never by a page: not precached.
        globIgnores: ['**/node_modules/**/*', TAKEOVER],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        importScripts: [`${TAKEOVER}?v=${takeoverHash}`],
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

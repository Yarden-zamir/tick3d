/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The service worker keeps the app shell on the device, so the game opens and plays offline.
// The page registers it itself (src/pwa.ts) and shows its own "New version" notice.
export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // The glob below already lists every built file, icons included, so the plugin adds no copies.
      includeManifestIcons: false,
      manifest: {
        name: 'tick3d',
        short_name: 'tick3d',
        description: '3D tic-tac-toe on a 4×4×4 cube',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // The page color of the light theme (--page in src/style.css).
        background_color: '#e4e7ff',
        theme_color: '#e4e7ff',
        icons: [
          { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
          // Tom's 512 artwork at 62% on the page colour, inside the safe zone that Android crops to.
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The plugin adds manifest.webmanifest itself.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // A page address opens the cached app. API calls always go to the network.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // The font list from Google changes rarely. Keep a copy for offline use.
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Font files have versioned addresses, so a cached file never goes stale.
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // Vitest runs the unit tests only. Playwright runs the e2e/ tests against a deployed site (npm run e2e).
  test: { include: ['{src,server}/**/*.test.ts'] },
});

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
        // The page color and the board color of the light theme (--page and --slab in src/style.css).
        // An installed app starts with these, then the page sets the bar to the saved theme.
        background_color: '#e4e7ff',
        theme_color: '#ffe14d',
        icons: [
          { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
          // Tom's 512 artwork at 62% on the page colour, inside the safe zone that Android crops to.
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The plugin adds manifest.webmanifest itself.
        // woff2: the page font (src/fonts), so the game keeps its look offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // A page address opens the cached app. API calls always go to the network.
        navigateFallback: 'index.html',
        // /stats, /sound-training and /sound-input need no entry: the precache serves them from their .html files
        // (clean URLs), online and offline. The query of a page address (?code=, ?mode=, ?return=) is for the page
        // script only, so the precache ignores it. Else /sound-input?code=… finds no entry and gets index.html.
        ignoreURLParametersMatching: [/./],
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  // Four pages: the game, the public stats page at /stats, the ear training at /sound-training, and the
  // microphone toy at /sound-input.
  build: { rollupOptions: { input: { main: 'index.html', stats: 'stats.html', training: 'sound-training.html', input: 'sound-input.html' } } },
  // Vitest runs the unit tests only. Playwright runs the e2e/ tests against a deployed site (npm run e2e).
  test: { include: ['{src,server}/**/*.test.ts'] },
});

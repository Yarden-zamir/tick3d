/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import twaManifest from './android/twa-manifest.json' with { type: 'json' };
import { ASSET_LINKS_PATH, assetLinks } from './src/assetlinks.ts';
import { PAGES } from './src/pages.ts';

// The service worker keeps the app shell on the device, so the game opens and plays offline.
// The page registers it itself (src/pwa.ts) and shows its own "New version" notice.
export default defineConfig({
  plugins: [
    // The Digital Asset Links file of the Android app (src/assetlinks.ts). The Caddyfiles serve it as JSON.
    {
      name: 'tick3d-assetlinks',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: ASSET_LINKS_PATH, source: `${JSON.stringify(assetLinks(twaManifest), null, 2)}\n` });
      },
    },
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // The glob below already lists every built file, icons included, so the plugin adds no copies.
      includeManifestIcons: false,
      manifest: {
        name: 'tick3d',
        short_name: 'tick3d',
        description: '3D tic-tac-toe on a 4×4×4 cube',
        // The app identity. It equals the old start_url, so an installed app stays the same app.
        // The Android app (android/twa-manifest.json) opens the same start_url inside the same scope.
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        categories: ['games'],
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
        // Phone shots for the install dialog: the same scenes as the Play listing (android/store/), smaller.
        screenshots: [
          { src: 'screenshots/tower.webp', sizes: '540x960', type: 'image/webp', form_factor: 'narrow', label: 'The 4×4×4 tower' },
          { src: 'screenshots/win.webp', sizes: '540x960', type: 'image/webp', form_factor: 'narrow', label: 'A won game' },
          { src: 'screenshots/online.webp', sizes: '540x960', type: 'image/webp', form_factor: 'narrow', label: 'An online game with chat' },
        ],
      },
      workbox: {
        // The plugin adds manifest.webmanifest itself.
        // woff2: the page font (src/fonts), so the game keeps its look offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The install dialog loads the screenshots online only, so the offline cache skips them.
        globIgnores: ['screenshots/**'],
        // A page address opens the cached app. API calls always go to the network.
        navigateFallback: 'index.html',
        // The other pages (src/pages.ts) need no entry: the precache serves them from their .html files
        // (clean URLs), online and offline. The query of a page address (?code=, ?mode=, ?return=) is for the page
        // script only, so the precache ignores it. Else /sound-input?code=… finds no entry and gets index.html.
        ignoreURLParametersMatching: [/./],
        // /.well-known/: Android and a browser get the asset links file, not the app.
        navigateFallbackDenylist: [/^\/api\//, /^\/\.well-known\//],
      },
    }),
  ],
  // One entry per page in src/pages.ts.
  build: { rollupOptions: { input: Object.fromEntries(Object.entries(PAGES).map(([name, { file }]) => [name, file])) } },
  // Vitest runs the unit tests only. Playwright runs the e2e/ tests against a deployed site (npm run e2e).
  test: { include: ['{src,server}/**/*.test.ts'] },
});

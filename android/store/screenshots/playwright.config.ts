import { defineConfig, devices } from '@playwright/test';
import { TARGETS } from './targets.ts';

// Renders the store screenshots (store.spec.ts) once per target in targets.json, then the captioned
// shots (caption.spec.ts), the feature graphic and the ads (art.spec.ts) from those shots. The store-images workflow runs it and convert.py turns the
// PNG files into the store formats.
export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One worker: the online scene makes sessions on the local build, and production keeps its load low.
  workers: 1,
  // The scenes read production and draw the board in software, so a slow answer can time out once.
  retries: 1,
  reporter: 'list',
  use: { baseURL: 'https://tick3d.yarden-zamir.com', isMobile: true, hasTouch: true },
  projects: [
    ...TARGETS.map(({ name, platform, size: [width, height], scale }) => ({
      name,
      testMatch: 'store.spec.ts',
      use: {
        viewport: { width: width / scale, height: height / scale },
        deviceScaleFactor: scale,
        // The iOS app adds tick3dApp/ios to the user agent of its web view (apple/capacitor.config.json).
        ...(platform === 'ios' ? { userAgent: `${devices['iPhone 15 Pro Max'].userAgent} tick3dApp/ios` } : {}),
      },
    })),
    // The art uses the phone shots, so it waits for them.
    { name: 'art', testMatch: 'art.spec.ts', dependencies: ['play-phone'], use: { isMobile: false, hasTouch: false } },
    {
      name: 'captions',
      testMatch: 'caption.spec.ts',
      dependencies: TARGETS.filter((target) => target.caption).map((target) => target.name),
      use: { isMobile: false, hasTouch: false },
    },
  ],
});

import { defineConfig } from '@playwright/test';

// Renders the Play store screenshots (store.spec.ts) at a phone viewport: 360 × 640 at 3× is 1080 × 1920.
// The play-screenshots workflow runs it and convert.py turns the PNG files into the store formats.
export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // The feature graphic uses the tower shot, so the tests run in order.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'https://tick3d.yarden-zamir.com',
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
});

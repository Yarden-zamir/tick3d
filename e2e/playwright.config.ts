import { defineConfig, devices } from '@playwright/test';

// The suite tests a deployed site: a pull request preview or a local server. It never picks a
// default, so a run cannot reach production by mistake.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error('Set E2E_BASE_URL to the site to test, for example https://pr-17.tick3d.yarden-zamir.com');
}

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  fullyParallel: true,
  workers: 4,
  // The online and computer games play many turns, and the time limit tests wait for a timeout.
  timeout: 90_000,
  // Chromium draws the 3D board in software in a container, so a busy page answers slowly.
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

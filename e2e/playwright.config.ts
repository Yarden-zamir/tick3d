import { defineConfig, devices } from '@playwright/test';

// The suite tests a deployed site: a pull request preview or a local server. It never picks a
// default, so a run cannot reach production by mistake.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error('Set E2E_BASE_URL to the site to test, for example https://pr.17.tick3d.yarden-zamir.com');
}

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  fullyParallel: true,
  // The tests wait on the network and on the 3D page, not on the CPU, so more workers than cores help.
  workers: 6,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

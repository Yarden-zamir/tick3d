import twaManifest from '../android/twa-manifest.json' with { type: 'json' };
import { expect, test } from './fixtures.ts';

// The parts of the site that the Android app (android/twa-manifest.json) and its Play listing need.

test('the asset links file names the Android app, as JSON', async ({ request }) => {
  const response = await request.get('/.well-known/assetlinks.json');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const [link] = (await response.json()) as [{ target: { package_name: string } }];
  expect(link.target.package_name).toBe(twaManifest.packageId);
});

test('the web manifest keeps the app identity and scope that the Android app opens', async ({ request }) => {
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as Record<string, unknown>;
  expect(manifest).toMatchObject({ id: '/', start_url: twaManifest.startUrl, scope: new URL(twaManifest.fullScopeUrl).pathname });
});

test('the Info panel links to the privacy policy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Info' }).click();
  await page.locator('#info-panel').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Delete your data' })).toBeVisible();
});

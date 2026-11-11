import type { Browser, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

// "Get the app" in the footer links to the Android app on Google Play (src/header/get-app.ts). It shows only in a
// browser that can install the app, while the listing is live. The tests answer GET /api/stores themselves, because
// the server asks Google.

const PLAY = 'https://play.google.com/store/apps/details?id=com.yardenzamir.tick3d';
const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 tick3dApp/ios';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function playStage(page: Page, play: 'live' | 'testing'): Promise<void> {
  await page.route('**/api/stores', (route) => route.fulfill({ json: { play } }));
}

async function newPage(browser: Browser, baseURL: string | undefined, userAgent?: string): Promise<Page> {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), ...(userAgent === undefined ? {} : { userAgent }) });
  return context.newPage();
}

test('a browser on a computer gets the link while the app is live', async ({ page }) => {
  await playStage(page, 'live');
  await page.goto('/');
  await expect(page.locator('.site-footer').getByRole('link', { name: 'Get the app' })).toHaveAttribute('href', PLAY);
});

test('the link stays hidden while the app is in the closed test', async ({ page }) => {
  await playStage(page, 'testing');
  const answered = page.waitForResponse('**/api/stores');
  await page.goto('/');
  await answered;
  await expect(page.locator('#get-app-link')).toBeHidden();
});

test('the Android app hides the link on its first page and on the next pages of the tab', async ({ browser, baseURL }) => {
  const page = await newPage(browser, baseURL);
  await playStage(page, 'live');
  // Chrome opens the first page of the Trusted Web Activity with this referrer. A link to the next page loses it.
  await page.addInitScript(() => {
    if (location.pathname !== '/') return;
    Object.defineProperty(Document.prototype, 'referrer', { get: () => 'android-app://com.yardenzamir.tick3d/' });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'android');
  await expect(page.locator('#get-app-link')).toBeHidden();
  await page.goto('/stats');
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'android');
  await expect(page.locator('#get-app-link')).toBeHidden();
  await page.context().close();
});

for (const [name, userAgent] of [
  ['the iOS app', IOS_APP],
  ['Safari on an iPhone', IPHONE_SAFARI],
]) {
  test(`${name} hides the link, because the iOS app is not public`, async ({ browser, baseURL }) => {
    const page = await newPage(browser, baseURL, userAgent);
    await playStage(page, 'live');
    await page.goto('/');
    await expect(page.locator('#get-app-link')).toBeHidden();
    await page.context().close();
  });
}

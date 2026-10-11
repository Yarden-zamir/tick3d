import { expect, test } from './fixtures.ts';

// The iOS app (apple/capacitor.config.json) loads the site and adds this marker to the user agent.
// The site then hides what the App Store does not allow: GitHub links, the previews of pull requests and
// the GitHub login (src/platform.ts).
const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 tick3dApp/ios';

test('the iOS app hides the GitHub link, the previews and the GitHub login', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), userAgent: IOS_APP });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'ios');
  await expect(page.getByRole('link', { name: 'GitHub' })).toBeHidden();
  await expect(page.locator('#previews-button')).toBeHidden();
  await page.locator('#account-button').click();
  await expect(page.locator('#my-games')).toBeVisible();
  await expect(page.locator('.login-link')).toHaveCount(0);
  await context.close();
});

test('a browser keeps the GitHub link', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'web');
  await expect(page.getByRole('link', { name: 'GitHub' })).toBeVisible();
});

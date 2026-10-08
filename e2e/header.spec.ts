import type { Page } from '@playwright/test';
import { keysOf } from '../src/guards.ts';
import { PAGES, type PageName } from '../src/pages.ts';
import { expect, test } from './fixtures.ts';

// Every page has the same header (src/header/). Info opens the own text of each page.

// The heading of the Info panel of each page. A new page in src/pages.ts needs an entry here.
const INFO = {
  main: 'How to win',
  stats: 'About these stats',
  training: 'How the ear training works',
  input: 'How the Voice room works',
} as const satisfies Record<PageName, string>;

const USER = { login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4' };

// The server answers that a GitHub user is logged in. The test needs no real login.
async function fakeLogin(page: Page): Promise<void> {
  await page.route('**/api/me', (route) => route.fulfill({ json: { loginAvailable: true, user: USER } }));
}

for (const name of keysOf(PAGES)) {
  const { path } = PAGES[name];
  const info = INFO[name];
  test(`the header of ${path} has the wordmark, the account, Info, kitshn and GitHub`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(path);
    await expect(page.locator('#home-link')).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/Yarden-zamir/tick3d');
    await expect(page.locator('#account-button')).toBeVisible();

    const panel = page.locator('#info-panel');
    await expect(panel).toBeHidden();
    await page.getByRole('button', { name: 'Info' }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(info);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();

    await page.getByRole('button', { name: 'Previews of open pull requests' }).click();
    const previews = page.locator('#previews');
    await expect(previews).toHaveAttribute('open');
    await expect(previews.locator('#previews-list')).not.toContainText('Loading');
    await previews.getByRole('button', { name: 'Close' }).click();
    await expect(previews).not.toHaveAttribute('open');
    expect(errors).toEqual([]);
  });
}

test('the account button of /stats opens My games on the game page, and a login returns to /stats', async ({ page }) => {
  await fakeLogin(page);
  await page.goto(PAGES.stats.path);
  // The header shows the login, as on the game page.
  await expect(page.locator('#account-name')).toHaveText(USER.login);
  await expect(page.locator('#account-button')).toHaveAttribute('aria-label', `My games, logged in as ${USER.login}`);

  await page.unroute('**/api/me');
  await page.route('**/api/me', (route) => route.fulfill({ json: { loginAvailable: true, user: null } }));
  await page.locator('#account-button').click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.locator('#my-games')).toHaveAttribute('open');
  // The address drops the request, so a reload does not open the dialog again.
  await expect(page).toHaveURL((url) => !url.searchParams.has('open') && !url.searchParams.has('return'));
  const login = page.locator('.login-link');
  await expect(login).toHaveCount(1);
  const href = new URL((await login.getAttribute('href')) ?? '', page.url());
  expect(new URL(href.searchParams.get('return') ?? '').pathname).toBe(PAGES.stats.path);
});

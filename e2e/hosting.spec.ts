import { test, expect } from '@playwright/test';
import { STORAGE_KEYS } from '../src/storage-keys.ts';

for (const theme of ['light', 'dark']) {
  test(`a free player can join, but cannot host (${theme})`, async ({ page, request }, info) => {
    const health = await (await request.get('/api/health')).json() as { lan: unknown };
    test.skip(health.lan !== null, 'Self-hosted servers do not require a purchase.');
    await page.addInitScript(({ key, theme }) => localStorage.setItem(key, JSON.stringify({ theme, mode: 'online' })), { key: STORAGE_KEYS.settings, theme });
    const creates: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') creates.push(request.url());
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#hosting-note')).toBeVisible();
    await expect(page.locator('#new-code')).toBeHidden();
    await expect(page.locator('#online-name-field')).toBeHidden();
    await expect(page.locator('#join-code')).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Google Play' })).toHaveAttribute('href', 'https://play.google.com/store/apps/details?id=com.yardenzamir.tick3d');
    await expect(page.locator('#hosting-app-store')).toHaveAttribute('href', /^https:\/\/apps\.apple\.com\//);
    expect(creates).toEqual([]);
    await page.screenshot({ path: info.outputPath(`online-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Nearby', exact: true }).click();
    await expect(page.locator('#nearby-host')).toBeVisible();
    await expect(page.locator('#nearby-join')).toBeVisible();
  });
}

test('a proved host creates a game and a free browser joins it', async ({ browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('The test needs a base URL');
  // A local test server seeds this token through openStore before start. Never use a real buyer token.
  const token = process.env.E2E_PURCHASED_TOKEN;
  test.skip(token === undefined, 'Needs a locally seeded proved copy. No purchase bypass exists in the API.');
  const host = await browser.newContext({ baseURL });
  const guest = await browser.newContext({ baseURL });
  try {
    await host.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: STORAGE_KEYS.player, token: token ?? '' });
    const page = await host.newPage();
    await page.goto('/');
    await expect(page.locator('#new-code')).not.toHaveAttribute('hidden', '');
    await page.getByRole('button', { name: 'Online', exact: true }).click();
    await expect(page).toHaveURL(/code=/);
    const code = new URL(page.url()).searchParams.get('code');
    if (code === null) throw new Error('The host got no game code');
    const joiner = await guest.newPage();
    await joiner.goto(`/?code=${code}`);
    await expect(joiner.locator('#status')).toContainText('move (X)');
    await expect(joiner.locator('#online-code')).toHaveText(code);
    await expect(joiner.locator('#new-code')).toBeHidden();
  } finally {
    await host.close();
    await guest.close();
  }
});

import type { Page } from '@playwright/test';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
import { expect, test } from './fixtures.ts';

// The Share button of the game header. The share sheet is fake, so the test reads what the page shares.
// This file creates 1 online session (the server allows 60 per hour for one client address).

async function fakeShareSheet(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.assign(navigator, {
      share: async (data: ShareData) => {
        Object.assign(window, { e2eShared: data });
      },
    });
  });
}

const shared = (page: Page) => page.evaluate(() => (window as unknown as { e2eShared?: ShareData }).e2eShared);

test('Share tick3d shares only the invite link with the person id of this player', async ({ open }) => {
  const { page } = await open();
  await fakeShareSheet(page);
  const token = await page.evaluate((key) => localStorage.getItem(key) ?? '', STORAGE_KEYS.player);
  const me = (await (await page.request.get('/api/me', { headers: { 'x-player': token } })).json()) as { person: string };
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.getByRole('button', { name: 'Share tick3d' }).click();
      return shared(page);
    })
    .toEqual({ url: `${new URL(page.url()).origin}/share?by=${me.person}` });
});

test('Play online with a friend starts an online game and shares its play link', async ({ open }) => {
  const { page } = await open();
  await fakeShareSheet(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const menu = page.locator('#game-share-menu');
  await expect(menu.getByRole('button', { name: 'Play online with a friend' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]code=[A-Z0-9]{4}/);
  const code = new URL(page.url()).searchParams.get('code');
  await expect.poll(async () => (await shared(page))?.url).toBe(`${new URL(page.url()).origin}/?code=${code}`);
});

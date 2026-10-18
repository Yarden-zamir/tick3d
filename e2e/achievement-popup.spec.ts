import type { Page } from '@playwright/test';
import { ACHIEVEMENTS, type AchievementId, type AchievementProgress, achievementProgress, rarityOf } from '../src/achievements.ts';
import { toEpochMs as ms } from '../src/epoch.ts';
import { PAGES } from '../src/pages.ts';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
import { expect, test } from './fixtures.ts';

// The popup of unlocks that came away from an end card of this device, such as an invite on /testing.
// The answer of GET /api/me/achievements is fake, so the test needs no invite on the server.

// The progress with these achievements unlocked, the first one the newest.
function progress(ids: readonly AchievementId[]): AchievementProgress[] {
  return achievementProgress([]).map((entry) => {
    const index = ids.indexOf(entry.id);
    const goal = ACHIEVEMENTS.find((rule) => rule.id === entry.id)?.goal ?? 1;
    return index === -1 ? entry : { ...entry, count: goal, unlockedAt: ms(1_000_000 - index * 1000) };
  });
}

// Answers GET /api/me/achievements with the unlocks in `now.ids`, which the test can change.
async function fakeAchievements(page: Page, now: { ids: AchievementId[] }): Promise<void> {
  await page.route('**/api/me/achievements', (route) => {
    const achievements = progress(now.ids);
    return route.fulfill({ json: { achievements, rarity: rarityOf([achievements]) } });
  });
}

const popup = (page: Page) => page.locator('#achievement-popup');

test('the first check of a device shows the newest unlocks, with the rest in My games, once', async ({ open }) => {
  // The privacy page makes no check, so the fake answer is the first one that the game page gets.
  const { page } = await open({ path: PAGES.privacy.path });
  await fakeAchievements(page, { ids: ['invite-1', 'first-win', 'games-10', 'elevator', 'friend-game'] });
  await page.goto('/');
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator('h2')).toHaveText('5 achievements unlocked');
  await expect(popup(page).locator('li')).toHaveText([/Plus one/, /First win/, /Regular/]);
  await popup(page).getByRole('button', { name: '+2 more in My games' }).click();
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#my-games')).toHaveAttribute('open');

  // The device saw them all, so a new visit shows nothing.
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/me/achievements'));
  await page.reload();
  await checked;
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown, STORAGE_KEYS.achievementsSeen)).toHaveLength(5);
  await expect(popup(page)).toBeHidden();
});

test('a new unlock shows when the page comes back to the front, and Close hides it', async ({ open }) => {
  const { page } = await open({ path: PAGES.privacy.path });
  const now = { ids: [] as AchievementId[] };
  await fakeAchievements(page, now);
  await page.goto('/');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.achievementsSeen)).toBe('[]');

  now.ids = ['invite-1'];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(popup(page).locator('h2')).toHaveText('Achievement unlocked');
  await expect(popup(page).locator('li')).toHaveText([/Plus one.*invite link/]);
  await expect(popup(page).getByRole('button', { name: /more in My games/ })).toBeHidden();
  // The game stays playable under the popup: it is no modal.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await popup(page).getByRole('button', { name: 'Close' }).click();
  await expect(popup(page)).toBeHidden();
});

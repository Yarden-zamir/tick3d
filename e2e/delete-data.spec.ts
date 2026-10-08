import { callApi, cell, expect, playerToken, status, storedSettings, test } from './fixtures.ts';

// X wins along 0, 16, 32, 48. O plays 1, 2, 3.
const X_WINS = [0, 1, 16, 2, 32, 3, 48];

test('Delete my data empties My games on the server and on this device, and keeps the settings', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  for (const index of X_WINS) await cell(page, index).click();
  await expect(status(page)).toHaveText('Player X wins!');
  await page.locator('#end-card-close').click();
  // The page uploads the finished game in the background.
  await expect.poll(async () => ((await callApi(page, '/api/me/history')) as { games: unknown[] }).games.length).toBe(1);
  const token = await playerToken(page);

  await page.locator('#account-button').click();
  await expect(page.locator('#my-games-history li:not(.empty)')).toHaveCount(1);
  await expect(page.locator('#my-games-device')).toContainText('1 game');
  await page.locator('#my-games-delete').click();
  const dialog = page.locator('#delete-confirm');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This deletes the data of this device');
  await expect(dialog).toContainText('Your custom name');
  await page.locator('#delete-confirm-yes').click();
  await expect(page.locator('#delete-confirm-status')).toContainText('Your data is deleted');
  await expect(page.locator('#delete-confirm-form')).toBeHidden();
  // The settings stay without the tick, and so does the player token.
  expect(await storedSettings(page)).toMatchObject({ mode: 'friend' });
  expect(await playerToken(page)).toBe(token);

  // Closing the dialog starts the page fresh.
  await Promise.all([page.waitForEvent('load'), page.locator('#delete-confirm-no').click()]);
  await page.locator('#account-button').click();
  await expect(page.locator('#my-games-history')).toHaveText('No finished games yet.');
  await expect(page.locator('#my-games-online')).toHaveText('No online sessions yet.');
  await expect(page.locator('#my-games-device')).not.toContainText(/[1-9] games?/);
  await expect(page.locator('#my-games-stats').first()).toContainText('0 won · 0 lost · 0 drawn');
  await expect(page.locator('#my-games-stats')).not.toContainText(/[1-9]/);
  expect(await callApi(page, '/api/me/history')).toEqual({ games: [], more: false });
});

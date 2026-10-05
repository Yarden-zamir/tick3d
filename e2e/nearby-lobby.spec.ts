import { cell, expect, expectMyMove, expectToast, marks, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const nearby = { settings: { mode: 'nearby' } };

// Browsers in one test run share one address, so they are on one network for the server. Other
// tests host Nearby games at the same time, so each host here has a name of its own.
const uniqueName = (role: string) => `${role} ${Math.random().toString(36).slice(2, 8)}`;
const listed = (page: Page, name: string) => page.locator('#nearby-hosts li').filter({ hasText: name });

test('a hosted game shows in the list of another device, which joins it with one tap', async ({ open }) => {
  const name = uniqueName('Lobby host');
  const { page: host, context: hostContext } = await open(nearby);
  await host.locator('#nearby-name').fill(name);
  await host.locator('#nearby-host').click();
  await expect(host.locator('#nearby-visible')).toBeVisible();
  await expect(host.locator('#nearby-lobby')).toBeHidden();

  const { page: guest } = await open(nearby);
  await expect(guest.locator('#nearby-lobby')).toBeVisible();
  await expect(listed(guest, name)).toHaveCount(1);
  await expect(listed(guest, name).locator('.device-icon svg')).toHaveCount(1);
  // Another tab of the host's browser is the same device, so its list never shows its own game.
  const ownTab = await hostContext.newPage();
  await ownTab.goto('/');
  await expect(ownTab.locator('#nearby-lobby')).toBeVisible();
  await expect(listed(ownTab, name)).toHaveCount(0);
  await ownTab.close();

  // A third device stays in the list view and sees the game come back with a fresh offer.
  const { page: watcher } = await open(nearby);
  await expect(listed(watcher, name)).toHaveCount(1);

  await listed(guest, name).getByRole('button', { name: `Join ${name}` }).click();
  await expectToast(guest, 'as O');
  await expectToast(host, 'joined');
  await expect(guest.locator('#nearby-lobby')).toBeHidden();
  await expect(host.locator('#nearby-devices li')).toHaveCount(2);

  await cell(host, 0).click();
  await expect(marks(guest)).toHaveCount(1);
  await expectMyMove(guest);
  await cell(guest, 1).click();
  await expect(marks(host)).toHaveCount(2);

  await expect(listed(watcher, name)).toHaveCount(1);
  await host.locator('#nearby-stop').click();
  await expectToast(guest, 'host ended');
  await expect(listed(watcher, name)).toHaveCount(0);
});

test('Nearby has no join box, and the computer mode keeps its own controls', async ({ open }) => {
  const { page } = await open(nearby);
  await expect(page.locator('#nearby-host')).toBeVisible();
  for (const id of ['#join', '#undo', '#advanced', '#lock', '#new-game', '#score']) await expect(page.locator(id), id).toBeHidden();
  await expect(page.locator('[data-setting="difficulty"]')).toBeHidden();

  await page.getByRole('button', { name: 'Computer' }).click();
  await expect(page.locator('[data-setting="difficulty"]')).toBeVisible();
  for (const id of ['#join', '#undo', '#advanced', '#lock', '#new-game']) await expect(page.locator(id), id).toBeVisible();
  await expect(page.locator('#nearby-host')).toBeHidden();
});

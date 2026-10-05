import { cell, expect, expectMyMove, expectToast, ownName, status, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const nearby = { settings: { mode: 'nearby' } };

// Browsers in one test run share one address, so they are on one network for the server. Other
// tests host Nearby games at the same time. Each player has a generated name of its own, so a test
// finds its host by that name.
const listed = (page: Page, name: string) => page.locator('#nearby-hosts li').filter({ hasText: name });

test('a hosted game shows in the list of another device, which joins it with one tap', async ({ open }) => {
  const { page: host, context: hostContext } = await open(nearby);
  // The device name starts as the generated name of the player, so the list shows that name.
  const name = await ownName(host);
  await expect(host.locator('#nearby-name')).toHaveValue(name);
  await host.locator('#nearby-host').click();
  await expect(host.locator('#nearby-visible')).toBeVisible();
  await expect(host.locator('#nearby-lobby')).toBeHidden();

  const { page: guest } = await open(nearby);
  const guestName = await ownName(guest);
  await expect(status(guest)).toHaveText('Host a game, or join one.');
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
  await expect(host.locator('#nearby-devices')).toContainText(`${guestName}Plays O`);
  await expect(guest.locator('#nearby-devices')).toContainText(`${guestName}You · Plays O`);

  // X wins on 0, 16, 32, 48. O plays 1, 2, 3.
  for (const [page, index] of [[host, 0], [guest, 1], [host, 16], [guest, 2], [host, 32], [guest, 3], [host, 48]] as const) {
    await expectMyMove(page);
    await cell(page, index).click();
    await expect(status(page)).not.toContainText('Your move');
  }
  await expect(status(guest)).toHaveText(`${name} wins!`);
  // Both devices show the host's link: its result names both players.
  await expect(host).toHaveURL(/[?&]game=[A-Z2-9]{8}/);
  const id = new URL(host.url()).searchParams.get('game');
  await expect(guest).toHaveURL(new RegExp(`[?&]game=${id ?? 'none'}`));

  await expect(listed(watcher, name)).toHaveCount(1);
  await host.locator('#end-card-close').click();
  await host.locator('#nearby-stop').click();
  await expectToast(guest, 'host ended');
  await expect(listed(watcher, name)).toHaveCount(0);
});

test('Nearby has no join box, and the computer mode keeps its own controls', async ({ open }) => {
  const { page } = await open(nearby);
  await expect(page.locator('#nearby-host')).toBeVisible();
  await expect(status(page)).toHaveText('Host a game, or join one.');
  for (const id of ['#join', '#undo', '#advanced', '#lock', '#new-game', '#score']) await expect(page.locator(id), id).toBeHidden();
  await expect(page.locator('[data-setting="difficulty"]')).toBeHidden();

  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.locator('[data-setting="difficulty"]')).toBeVisible();
  for (const id of ['#join', '#undo', '#advanced', '#lock', '#new-game']) await expect(page.locator(id), id).toBeVisible();
  await expect(page.locator('#nearby-host')).toBeHidden();
});

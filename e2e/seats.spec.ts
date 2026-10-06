import { createOnline, expect, expectToast, joinAsO, ownName, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

// This file creates one online session. The server allows 60 new sessions per hour for one client address.

const players = (page: Page) => page.locator('#players-list li');
const playerRow = (page: Page, name: string) => players(page).filter({ hasText: name });

test('players change seats, with the other player asked first, and a custom name reaches the other screens', async ({ open }) => {
  const { page: alice } = await open();
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  const { page: carol } = await open({ path: `/?code=${code}` });
  await expectToast(carol, 'You are watching');
  const carolName = await ownName(carol);

  // Bob renames himself in My games. Alice sees the new name in the score and the chat.
  await bob.locator('#account-button').click();
  await bob.locator('#account-box').getByRole('button', { name: 'Rename' }).click();
  await bob.locator('#account-box input').fill('  Bob   Builder ');
  await bob.locator('#account-box').getByRole('button', { name: 'Save' }).click();
  await expect(bob.locator('#account-box b')).toHaveText('Bob Builder');
  await bob.locator('#my-games-close').click();
  await expect(alice.locator('.tally.O')).toContainText('Bob Builder');
  await bob.locator('#chat-input').fill('hello');
  await bob.locator('#chat-input').press('Enter');
  await expect(alice.locator('#chat-log')).toContainText('Bob Builder');

  // Every screen lists both seats and the watcher. A watcher sees no seat controls.
  for (const page of [alice, bob, carol]) await expect(players(page)).toHaveCount(3);
  await expect(carol.locator('#players-list button')).toHaveCount(0);
  // The watcher sees "You" on its own row; the players do not.
  await expect(playerRow(carol, carolName)).toContainText('You · Watching');
  await expect(playerRow(alice, carolName)).not.toContainText('You');

  // Alice (X) asks to swap. Bob gets a prompt and accepts. The seats trade on all three screens.
  await playerRow(alice, 'You').getByRole('button', { name: 'Swap X and O' }).click();
  await expect(alice.locator('#players-request')).toContainText('Waiting for Bob Builder');
  await expect(bob.locator('#seat-prompt')).toHaveAttribute('open');
  await expect(bob.locator('#seat-prompt-text')).toContainText('wants to swap X and O');
  await bob.locator('#seat-prompt-accept').click();
  await expectToast(alice, 'You play O now');
  for (const page of [alice, bob, carol]) await expect(players(page).first()).toContainText('Bob Builder');
  await expect(carol.locator('#seat-prompt')).not.toHaveAttribute('open');

  // Alice (now O) moves to watching, with no prompt. Bob (X) seats Carol in the empty seat; Carol is not asked.
  await playerRow(alice, 'You').getByRole('button', { name: 'Watch instead' }).click();
  await expectToast(bob, 'Seat O is free now');
  await playerRow(bob, carolName).getByRole('button', { name: 'Seat here' }).click();
  await expectToast(carol, 'You play O now');
  await expect(carol.locator('#seat-prompt')).not.toHaveAttribute('open');

  // Bob asks to make Carol a watcher. Carol declines, so nothing changes.
  await players(bob).nth(1).getByRole('button', { name: 'Make watcher' }).click();
  await expect(carol.locator('#seat-prompt')).toHaveAttribute('open');
  await expect(carol.locator('#seat-prompt-text')).toContainText('wants you to watch instead');
  await carol.locator('#seat-prompt-decline').click();
  await expectToast(bob, 'declined');
  await expect(players(bob).nth(1)).toContainText(carolName);
  await expect(bob.locator('#players-request')).toBeHidden();
});

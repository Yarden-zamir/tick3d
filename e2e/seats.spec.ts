import { createOnline, expect, expectToast, joinAsO, ownName, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

// This file creates two online sessions. The server allows 60 new sessions per hour for one client address.

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

  // Alice (X) moves and asks to undo. Bob accepts, and no screen shows the mark any more.
  // The watcher has no move to take back, so the watcher sees no Undo.
  await alice.locator('.cell').nth(21).click();
  for (const page of [alice, bob, carol]) await expect(page.locator('.cell.x')).toHaveCount(1);
  await expect(alice.locator('#undo')).toBeEnabled();
  await expect(carol.locator('#undo')).toBeHidden();
  await alice.locator('#undo').click();
  await expect(bob.locator('#seat-prompt-text')).toContainText('wants to take back their last move');
  await bob.locator('#seat-prompt-accept').click();
  for (const page of [alice, bob, carol]) await expect(page.locator('.cell.x, .cell.o')).toHaveCount(0);
  await expectToast(alice, 'accepted');

  // A move of the other player ends an undo request on both screens.
  await alice.locator('.cell').nth(21).click();
  await expect(bob.locator('.cell.x')).toHaveCount(1);
  await alice.locator('#undo').click();
  await expect(bob.locator('#seat-prompt')).toHaveAttribute('open');
  await bob.keyboard.press('Escape');
  await bob.locator('.cell').nth(22).click();
  for (const page of [alice, bob]) await expect(page.locator('#players-request')).toBeHidden();
  await expect(alice.locator('.cell.x, .cell.o')).toHaveCount(2);

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
  await playerRow(bob, carolName).getByRole('button', { name: 'Seat as O' }).click();
  await expectToast(carol, 'You play O now');
  await expect(carol.locator('#seat-prompt')).not.toHaveAttribute('open');

  // Bob asks to make Carol a watcher. Carol declines, so nothing changes.
  await players(bob).nth(1).getByRole('button', { name: 'Move to watchers' }).click();
  await expect(carol.locator('#seat-prompt')).toHaveAttribute('open');
  await expect(carol.locator('#seat-prompt-text')).toContainText('wants you to watch instead');
  await carol.locator('#seat-prompt-decline').click();
  await expectToast(bob, 'declined');
  await expect(players(bob).nth(1)).toContainText(carolName);
  await expect(bob.locator('#players-request')).toBeHidden();
});

test('a request that nobody answers ends by itself on both screens', async ({ open }) => {
  test.setTimeout(150_000);
  const { page: alice } = await open();
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await playerRow(alice, 'You').getByRole('button', { name: 'Swap X and O' }).click();
  await expect(bob.locator('#seat-prompt')).toHaveAttribute('open');
  // While the request waits, the seat controls stay in place but are off.
  await expect(playerRow(alice, 'You').getByRole('button', { name: 'Swap X and O' })).toBeDisabled();
  // The holder sends no event when a request ends. Each screen drops it by its own timer.
  await expect(alice.locator('#players-request')).toBeHidden({ timeout: 75_000 });
  await expect(bob.locator('#players-request')).toBeHidden();
  await expect(bob.locator('#seat-prompt')).not.toHaveAttribute('open');
  await expect(playerRow(alice, 'You').getByRole('button', { name: 'Swap X and O' })).toBeEnabled();
});

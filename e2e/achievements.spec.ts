import { createOnline, expect, joinAsO, playTurns, status, test, xWins } from './fixtures.ts';
import { ACHIEVEMENTS } from '../src/achievements.ts';

// This file creates 1 online session (the server allows 60 per hour for one client address).

test('a won online game unlocks achievements on the end card and in My games', async ({ open }) => {
  const { page: alice } = await open();
  await createOnline(alice);
  const { page: bob } = await joinAsO(open, alice.url());
  await playTurns(xWins(alice, bob));
  await expect(status(alice)).toHaveText('You win!');

  // X won in 7 moves against a person online.
  // The card is open, so the unlock shows on it, with a badge for each achievement, and not in a toast.
  const strip = alice.locator('#end-card-achievements');
  await expect(strip).toHaveAccessibleName('Achievements unlocked: First win, Seven moves, Worthy opponent');
  await expect(strip.getByRole('button')).toHaveText(['', '', '']);
  await expect(strip.getByRole('button', { name: 'Seven moves' })).toBeVisible();
  await expect(strip).toContainText('First win');
  await strip.getByRole('button', { name: 'Worthy opponent' }).click();
  await expect(strip).toContainText('Beat a person online.');
  await expect(bob.locator('#end-card')).toHaveAttribute('open');
  await expect(bob.locator('#end-card-achievements')).toBeHidden();

  for (const [page, count] of [[alice, 3], [bob, 0]] as const) {
    await page.locator('#end-card-close').click();
    await page.locator('#account-button').click();
    await expect(page.locator('#my-games-achievements-summary')).toHaveText(`${count} of ${ACHIEVEMENTS.length} unlocked`);
    await expect(page.locator('#my-games-achievements li[data-state="unlocked"]')).toHaveCount(count);
  }
  // Bob played one game toward "Play 10 games".
  await expect(bob.locator('#my-games-achievements li', { hasText: 'Regular' })).toContainText('1 / 10');
  // A reset locks Alice's achievements again. Her history keeps the game.
  await alice.locator('#my-games-reset-achievements').click();
  await alice.locator('#reset-achievements-confirm-yes').click();
  await expect(alice.locator('#my-games-achievements-summary')).toHaveText(`0 of ${ACHIEVEMENTS.length} unlocked`);
  await expect(alice.locator('#my-games-achievements li[data-state="unlocked"]')).toHaveCount(0);
  await expect(alice.locator('#my-games-reset-achievements')).toBeHidden();
});

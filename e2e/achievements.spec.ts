import { createOnline, expect, joinAsO, playTurns, status, test, xWins } from './fixtures.ts';
import { ACHIEVEMENTS } from '../src/achievements.ts';

// This file creates 1 online session (the server allows 60 per hour for one client address).

test('a won online game unlocks achievements on the end card and in My games', async ({ open }) => {
  const { page: alice } = await open();
  await createOnline(alice);
  const { page: bob } = await joinAsO(open, alice.url());
  await playTurns(xWins(alice, bob));
  await expect(status(alice)).toHaveText('You win!');

  // X won in 7 moves against a person online, straight down the floors. A person counts as the top level
  // of each ladder, so the lower steps unlock too. The strip lists the rarest first, with room for 3 badges.
  // The card is open, so the unlock shows on it, with a badge for each achievement, and not in a toast.
  const unlocked = ['Machine breaker', 'Seven wonders', 'Getting serious', 'Lightning', 'Worthy opponent', 'Elevator', 'First win', 'Warm-up', 'Quick hands'];
  const strip = alice.locator('#end-card-achievements');
  await expect(strip).toHaveAccessibleName(`Achievements unlocked: ${unlocked.join(', ')}`);
  await expect(strip.getByRole('button')).toHaveCount(3);
  await expect(strip).toContainText('+6');
  await expect(strip).toContainText('Machine breaker');
  await strip.getByRole('button', { name: 'Seven wonders' }).click();
  await expect(strip).toContainText('Win in 7 moves against a person online or in Nearby.');
  await expect(bob.locator('#end-card')).toHaveAttribute('open');
  await expect(bob.locator('#end-card-achievements')).toBeHidden();

  for (const [page, count] of [[alice, unlocked.length], [bob, 0]] as const) {
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

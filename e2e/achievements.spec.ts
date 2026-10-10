import { createOnline, expect, expectToast, joinAsO, playTurns, status, test, xWins } from './fixtures.ts';
import { ACHIEVEMENTS } from '../src/achievements.ts';

// This file creates 1 online session (the server allows 60 per hour for one client address).

test('a won online game unlocks achievements on the end card and in My games', async ({ open }) => {
  const { page: alice } = await open();
  await createOnline(alice);
  const { page: bob } = await joinAsO(open, alice.url());
  await playTurns(xWins(alice, bob));
  await expect(status(alice)).toHaveText('You win!');

  // X won in 7 moves against a person online.
  const unlocked = 'Achievements unlocked: First win, Seven moves, Worthy opponent';
  await expect(alice.locator('#end-card-achievements')).toHaveText(unlocked);
  await expectToast(alice, unlocked);
  await expect(bob.locator('#end-card')).toHaveAttribute('open');
  await expect(bob.locator('#end-card-achievements')).toBeHidden();

  for (const [page, count] of [[alice, 3], [bob, 0]] as const) {
    await page.locator('#end-card-close').click();
    await page.locator('#account-button').click();
    await expect(page.locator('#my-games-achievements-summary')).toHaveText(`${count} of ${ACHIEVEMENTS.length} unlocked`);
    await expect(page.locator('#my-games-achievements li.unlocked')).toHaveCount(count);
  }
  // Bob played one game toward "Play 10 games".
  await expect(bob.locator('#my-games-achievements li', { hasText: 'Regular' })).toContainText('1/10');
});

import { cell, createOnline, expect, expectMyMove, expectToast, joinAsO, ownName, status, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

// This file creates one online session. The server allows 60 new sessions per hour for one client address.

// The player on X plays 0, 16, 32, 48 and wins. The player on O plays 1, 2, 3 in between.
async function xWins(x: Page, o: Page): Promise<void> {
  for (const [index, target] of [0, 1, 16, 2, 32, 3, 48].entries()) {
    const page = index % 2 === 0 ? x : o;
    await expectMyMove(page);
    await cell(page, target).click();
    await expect(status(page)).not.toContainText('Your move');
  }
  for (const page of [x, o]) {
    await expect(page.locator('#end-card')).toHaveAttribute('open');
    await page.locator('#end-card-close').click();
  }
}

const seatLock = (page: Page) => page.locator('#players [data-seat-lock]');

test('two players swap X and O for each new game, and the seat lock keeps the seats', async ({ open }) => {
  const { page: alice } = await open();
  const aliceName = await ownName(alice);
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await expect(seatLock(alice)).toHaveAttribute('aria-pressed', 'false');
  await expect(seatLock(alice)).toHaveAttribute('data-tip', /X and O swap after each game/);

  // Game 1: Alice is X and wins. Bob starts game 2: he was O, so he is X now and moves first.
  await xWins(alice, bob);
  await bob.locator('#new-game').click();
  await expectToast(alice, 'You play O now');
  await expect(status(bob)).toHaveText('Your move (X)');
  await expect(bob.locator('#players-list li').first()).toContainText('You');
  await expect(alice.locator('#players-list li').nth(1)).toContainText('You');
  // The score stays with the player: Alice won game 1 as X, and her win shows on her O seat now.
  await expect(bob.locator('.tally.O')).toContainText(aliceName);
  await expect(bob.locator('.tally.O b')).toHaveText('1');
  await expect(bob.locator('.tally.X b')).toHaveText('0');
  await bob.locator('#account-button').click();
  await expect(bob.locator('#my-games-session li').first()).toContainText(`${aliceName} won`);
  await bob.locator('#my-games-close').click();

  // Game 2: Bob is X and wins. Alice locks the seats, so game 3 keeps them: Bob stays X.
  await xWins(bob, alice);
  await seatLock(alice).click();
  await expectToast(bob, 'Seats locked');
  await expect(seatLock(bob)).toHaveAttribute('aria-pressed', 'true');
  await alice.locator('#new-game').click();
  await expect(alice.locator('#my-games-session li')).toHaveCount(3);
  await expect(status(bob)).toHaveText('Your move (X)');
  await expect(status(alice)).not.toContainText('Your move');
  await expect(bob.locator('.tally.X b')).toHaveText('1');
  await expect(bob.locator('.tally.O b')).toHaveText('1');
});

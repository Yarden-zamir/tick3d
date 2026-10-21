import { SIZE } from '../src/game.ts';
import { PAGES } from '../src/pages.ts';
import { expect, openMore, test } from './fixtures.ts';

test('hide coordinates keeps the last move off the keypad and points to the ear training', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'easy', human: 'X' } });
  // Hide goes in steps: the coordinates step also hides the history and the board, so the keypad places the moves.
  const hideCoordinates = page.getByRole('button', { name: 'Hide history, board and coordinates', exact: true });
  const hideBoard = page.getByRole('button', { name: 'Hide history and board', exact: true });
  const trainLink = page.locator('#train-link');
  const slots = page.locator('#coords-slots b');
  const tap = async (...digits: number[]) => {
    for (const digit of digits) await page.locator(`[data-digit="${digit}"]`).click();
  };
  await openMore(page);
  await expect(trainLink).toHaveAttribute('href', PAGES.training.path);
  await expect(trainLink).not.toHaveClass(/highlight/);

  await hideCoordinates.click();
  await expect(hideCoordinates).toHaveAttribute('aria-pressed', 'true');
  await expect(trainLink).toHaveClass(/highlight/);
  await tap(1, 1, 1);
  await page.locator('#coords-place').click();
  // The computer's move: the title names the player, the slots show no numbers, and the speaker still plays it.
  await expect(page.locator('#coords-title')).toContainText('played');
  await expect(slots).toHaveText(['?', '?', '?']);
  await expect(page.locator('#coords-hear')).toBeVisible();
  // The player's own typing still shows.
  await tap(2);
  await expect(slots.first()).toHaveText('2');
  await page.locator('#coords-back').click();

  // One step back shows the coordinates again, and the board stays hidden.
  await hideBoard.click();
  await expect(hideBoard).toHaveAttribute('aria-pressed', 'true');
  await expect(trainLink).not.toHaveClass(/highlight/);
  await expect(slots.first()).toHaveText(new RegExp(`^[1-${SIZE}]$`));
});

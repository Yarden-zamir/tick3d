import { SIZE } from '../src/game.ts';
import { PAGES } from '../src/pages.ts';
import { cell, expect, marks, test } from './fixtures.ts';

test('hide coordinates keeps the last move off the keypad and points to the ear training', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'easy', human: 'X' } });
  const toggle = page.getByRole('button', { name: 'Hide coordinates', exact: true });
  const trainLink = page.locator('#train-link');
  const slots = page.locator('#coords-slots b');
  await expect(trainLink).toHaveAttribute('href', PAGES.training.path);
  await expect(trainLink).not.toHaveClass(/highlight/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(trainLink).toHaveClass(/highlight/);
  await cell(page, 0).click();
  await expect(marks(page)).toHaveCount(2);
  // The computer's move: the title names the player, the slots show no numbers, and the speaker still plays it.
  await expect(page.locator('#coords-title')).toContainText('played');
  await expect(slots).toHaveText(['?', '?', '?']);
  await expect(page.locator('#coords-hear')).toBeVisible();
  // The player's own typing still shows.
  await page.locator('[data-digit="2"]').click();
  await expect(slots.first()).toHaveText('2');
  await page.locator('#coords-back').click();

  await toggle.click();
  await expect(trainLink).not.toHaveClass(/highlight/);
  await expect(slots.first()).toHaveText(new RegExp(`^[1-${SIZE}]$`));
});

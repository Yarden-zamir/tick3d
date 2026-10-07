import { expect, expectToast, marks, playComputerUntilEnd, status, test, toasts } from './fixtures.ts';
import type { Page } from '@playwright/test';

const hardComputer = { mode: 'computer', difficulty: 'hard', human: 'X' };
// The record key of the hard computer with no time limit and no hide setting.
const RECORD_KEY = 'hard|game:none|move:none|board:false|history:false';
// Scattered moves that build no line of their own, so the computer wins.
const SCATTERED = [0, 63, 3, 60, 12, 51, 15, 48, 5, 58, 10, 53, 17, 46, 30, 33, 7, 56, 24, 39, 40, 23, 9, 54, 2, 61, 13, 50, 32, 31];
const ORDER = [...SCATTERED, ...Array.from({ length: 64 }, (_, i) => i).filter((i) => !SCATTERED.includes(i))];

async function loseToComputer(page: Page): Promise<void> {
  await playComputerUntilEnd(page, ORDER);
  await expect(status(page)).toHaveText('Computer wins!');
  await expect(page.locator('#end-card')).toHaveAttribute('open');
}

const storedRecords = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tick3d.records') ?? '{}') as Record<string, number>);

test('a loss that beats the record shows it, stores it, and New game on the card starts over with the seats swapped', async ({ open }) => {
  const { page } = await open({ settings: hardComputer, records: { [RECORD_KEY]: 1 } });
  await loseToComputer(page);
  const moves = await marks(page).count();
  expect(await toasts(page)).toContainEqual(expect.stringContaining(`you lasted ${moves} moves`));
  await expect(page.locator('#end-card-image')).toHaveAttribute('alt', new RegExp(`New record: ${moves} moves`));
  expect((await storedRecords(page))[RECORD_KEY]).toBe(moves);

  await page.locator('#end-card-new-game').click();
  await expect(page.locator('#end-card')).not.toHaveAttribute('open');
  // X and O swap for each new game: the player is O now, so the computer moves first.
  await expectToast(page, 'you play O in this game');
  await expect(page.locator('[data-setting="human"] [data-value="O"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText('Your move (O)');
  await expect(marks(page)).toHaveCount(1);
});

test('the first loss of a setup sets its record without a message', async ({ open }) => {
  const { page } = await open({ settings: hardComputer, records: { [RECORD_KEY]: 1 } });
  const toggle = page.locator('[data-toggle="hideHistory"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await loseToComputer(page);
  expect(await toasts(page)).not.toContainEqual(expect.stringContaining('New record'));
  expect(Object.keys(await storedRecords(page))).toContainEqual(expect.stringMatching(/history:true$/));
  await expect(page.locator('#end-card-image')).not.toHaveAttribute('alt', /New record/);
});

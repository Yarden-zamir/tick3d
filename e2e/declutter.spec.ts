import type { Page } from '@playwright/test';
import { LINES, type Mark } from '../src/game.ts';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import tutorial from '../src/tutorial-chapters.json' with { type: 'json' };
import { cell, expect, expectMyMove, expectToast, status, test } from './fixtures.ts';

// The settings panel is two cards: the common settings, and More, which starts closed.
// Info teaches the game with the tutorial video and a slider over its checkpoints, and on a phone a button points to the settings under the board.

test('More starts closed and opens on a press of its summary', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  const more = page.locator('#more');
  await expect(more).not.toHaveAttribute('open');
  await expect(more.getByText('You play')).toBeHidden();
  await more.locator('> summary').click();
  await expect(more).toHaveAttribute('open');
  await expect(more.getByText('You play')).toBeVisible();
});

// The checkpoints come from the video plan (src/tutorial-chapters.json), so the test reads them from there.
test('the tutorial slider snaps the video to the frame of a checkpoint and shows its headline and text', async ({ open }) => {
  const { page } = await open({ settings: { muted: true } });
  await page.getByRole('button', { name: 'Info' }).click();
  const first = tutorial.chapters[0];
  const last = tutorial.chapters.at(-1);
  if (first === undefined || last === undefined) throw new Error('the tutorial has no chapters');
  await expect(page.locator('#tutorial-headline')).toHaveText(first.headline);
  await expect(page.locator('#tutorial-video')).toHaveAttribute('src', `/tutorial/${tutorial.video}`);

  await page.locator('#tutorial-range').fill(String(tutorial.chapters.length - 1));
  await expect(page.locator('#tutorial-headline')).toHaveText(last.headline);
  await expect(page.locator('#tutorial-text')).toHaveText(last.text);
  await expect(page.locator('#tutorial-bubble')).toHaveText(last.headline);
  await expect.poll(() => page.locator('#tutorial-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(last.frame, 1);
});

test('on a phone, the Settings button scrolls to the settings card and then hides', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  // A short phone: there the tower fills the screen. On a 390x844 phone the game actions show under the tower, so the button hides.
  await page.setViewportSize({ width: 375, height: 667 });
  const hint = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(hint).toBeVisible();
  await hint.click();
  await expect(page.locator('aside.panel')).toBeInViewport();
  await expect(hint).toBeHidden();
});

// The marks on the board, by cell.
const board = (page: Page): Promise<Mark[]> =>
  page.locator('.cell').evaluateAll((cells) => cells.map((c) => (c.classList.contains('x') ? 'X' : c.classList.contains('o') ? 'O' : null)));

// X wins when it can, blocks a line of three O, and else grows its best line that O does not touch.
function nextMove(marks: readonly Mark[]): number {
  const empty = (line: readonly number[]) => line.filter((c) => marks[c] === null);
  const count = (line: readonly number[], mark: Mark) => line.filter((c) => marks[c] === mark).length;
  // The empty cell of a line with three marks of one player.
  const lastCell = (mark: 'X' | 'O') => LINES.filter((l) => count(l, mark) === 3).flatMap(empty)[0];
  const urgent = lastCell('X') ?? lastCell('O');
  if (urgent !== undefined) return urgent;
  const best = LINES.filter((l) => count(l, 'O') === 0 && empty(l).length > 0).sort((a, b) => count(b, 'X') - count(a, 'X'))[0];
  const target = empty(best ?? LINES.find((l) => empty(l).length > 0) ?? [])[0];
  if (target === undefined) throw new Error('the board has no empty cell');
  return target;
}

// Easy blocks the first threat of a game for sure, and later threats by chance. A tuning without that
// chance makes the win sure. A tuned easy game still counts as easy for the move up.
const SURE_WIN_TUNING = {
  ...DEFAULT_TUNING,
  easy: { ...DEFAULT_TUNING.easy, fresh: { ...DEFAULT_TUNING.easy.fresh, block: 0, fork: 0 }, tired: { ...DEFAULT_TUNING.easy.tired, block: 0, fork: 0 } },
};

test('a second win in a row against easy moves the player up to medium; the body marks the turn', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'computer', difficulty: 'easy', human: 'X' } });
  await context.addInitScript(
    ({ keys, tuning }) => {
      if (localStorage.getItem(keys.levelUp) === null) localStorage.setItem(keys.levelUp, JSON.stringify({ easyWins: 1, done: false }));
      if (localStorage.getItem(keys.tuning) === null) localStorage.setItem(keys.tuning, JSON.stringify(tuning));
    },
    { keys: STORAGE_KEYS, tuning: SURE_WIN_TUNING },
  );
  await page.reload();
  // The first move of a game never colors the edge of the screen.
  await expectMyMove(page);
  await expect(page.locator('body')).not.toHaveAttribute('data-playing');
  await expect(page.locator('body')).not.toHaveAttribute('data-my-turn');

  let moved = false;
  while ((await status(page).getAttribute('data-state')) === 'playing') {
    await expectMyMove(page);
    // From the second turn on, the turn of this screen marks the body.
    if (moved) {
      await expect(page.locator('body')).toHaveAttribute('data-playing');
      await expect(page.locator('body')).toHaveAttribute('data-my-turn');
    }
    moved = true;
    const before = await page.locator('.cell.x').count();
    await cell(page, nextMove(await board(page))).click();
    await expect(page.locator('.cell.x')).toHaveCount(before + 1);
    // The computer answers, or the game ends.
    await expect(async () => {
      const state = await status(page).getAttribute('data-state');
      if (state === 'playing') await expect(page.locator('.cell.o')).toHaveCount(before + 1, { timeout: 500 });
    }).toPass();
  }
  await expect(status(page)).toHaveText('You win!');
  await expect(page.locator('body')).not.toHaveAttribute('data-my-turn');
  await expect(page.locator('body')).not.toHaveAttribute('data-playing');

  // On a phone Difficulty is under the board, so the move up scrolls down to it and back.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('#end-card-close').click();
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the page scrolled down to Difficulty' }).toBeGreaterThan(100);
  await expect(page.locator('[data-setting="difficulty"] [data-value="medium"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#difficulty-field')).toHaveClass(/level-up/);
  await expectToast(page, 'Two wins in a row against Easy. Up to Medium!');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown, STORAGE_KEYS.levelUp)).toEqual({ easyWins: 2, earned: true, done: true });
  // The player did not take over, so the page scrolls back to the top after the pop.
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the page scrolled back', timeout: 8000 }).toBe(0);
});

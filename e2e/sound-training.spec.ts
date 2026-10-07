import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

// The ear training page needs no server: it keeps its progress in localStorage.
// It plays sounds, and a headless browser plays them without a speaker.

const deckCells = (page: Page, mark = '') => page.locator(`#deck .cell${mark}`);
const deckCell = (page: Page, cell: number) => page.locator(`#deck .cell[data-cell="${cell}"]`);

// Every sound in the quiz, and every part at 100%, so the page asks for layers, rows, columns and full cells.
async function seedQuiz(page: Page): Promise<void> {
  const items: Record<string, { learn: number; box: number; due: number }> = {};
  for (const dimension of ['layer', 'row', 'column']) for (const value of [0, 1, 2, 3]) items[`${dimension}-${value}`] = { learn: 0, box: 1, due: 0 };
  const recent = Array<boolean>(20).fill(true);
  const progress = { version: 1, turn: 100, items, recent: { layer: recent, row: recent, column: recent }, last: null };
  await page.goto('/sound-training');
  await page.evaluate((value) => localStorage.setItem('tick3d.sound-training', JSON.stringify(value)), progress);
  await page.reload();
}

test('the ear training shows answers first, then hides them, and keeps its progress', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  const response = await page.goto('/sound-training');
  // The page is public: search engines may list it.
  expect(response?.headers()['x-robots-tag']).toBeUndefined();

  const kind = page.locator('#card-kind');
  const answer = page.locator('#card-answer');
  const next = page.locator('#next');
  // A new sound shows its answer, in words and as a whole area on the board.
  await expect(kind).toHaveText('New sound');
  await expect(answer).toBeVisible();
  await expect(answer).toContainText('layer');
  await expect(deckCells(page, '.right')).toHaveCount(16);

  // A few learn cards later, the first quiz card hides the answer.
  for (let i = 0; i < 10 && (await kind.textContent()) !== 'Quiz'; i++) await next.click();
  await expect(kind).toHaveText('Quiz');
  await expect(answer).toBeHidden();
  await expect(deckCells(page, '.right')).toHaveCount(0);
  await expect(page.locator('#check')).toBeDisabled();

  // Tap the last cell (layer 4, row 4, column 4) until an answer is wrong: the first sounds are layer,
  // row and column 1. The feedback marks it, and the item goes back to box 1 and stays due.
  const feedback = page.locator('#card-feedback');
  for (let i = 0; i < 30; i++) {
    if ((await kind.textContent()) !== 'Quiz') {
      await next.click();
      continue;
    }
    await deckCell(page, 63).click();
    await page.locator('#check').click();
    if ((await feedback.textContent())?.includes('wrong')) break;
    await next.click();
  }
  await expect(feedback).toContainText('wrong');
  await expect(deckCells(page, '.wrong')).toHaveCount(16);
  await expect(deckCells(page, '.right')).toHaveCount(16);
  await expect(page.locator('#yours')).toBeVisible();
  const asked = await page.locator('#deck').getAttribute('data-asked');
  const cell = Number(await deckCells(page, '.right').first().getAttribute('data-cell'));
  const coords = { layer: Math.floor(cell / 16), row: Math.floor(cell / 4) % 4, column: cell % 4 };
  if (asked !== 'layer' && asked !== 'row' && asked !== 'column') throw new Error(`a quiz card asks for ${asked}`);
  const item = page.locator(`.train-value[data-item="${asked}-${coords[asked]}"]`);
  await expect(item).toHaveAttribute('data-box', '1');
  await expect(item).toHaveAttribute('data-due', 'true');

  // The progress stays after a reload.
  const totals = await page.locator('#totals').textContent();
  expect(totals).toMatch(/^[1-9]\d* cards done/);
  await page.reload();
  await expect(page.locator('#totals')).toHaveText(totals ?? '');
  await expect(item).toHaveAttribute('data-box', '1');
  expect(errors).toEqual([]);
});

test('a tap selects a whole layer, row or column, or one cell on a full card', async ({ page }) => {
  await seedQuiz(page);
  const expected: Record<string, number> = { layer: 16, row: 16, column: 16, cell: 1 };
  const seen = new Set<string>();
  for (let i = 0; i < 60 && seen.size < 4; i++) {
    const asked = (await page.locator('#deck').getAttribute('data-asked')) ?? '';
    const count = expected[asked];
    if (count === undefined) throw new Error(`a quiz card asks for ${asked}`);
    if (!seen.has(asked)) {
      seen.add(asked);
      // Hover shows the same area as a tap. A tap on another cell moves the pick.
      await deckCell(page, 0).hover();
      await expect(deckCells(page, '.peer')).toHaveCount(count);
      await deckCell(page, 37).click();
      await expect(deckCells(page, '.picked')).toHaveCount(count);
      await expect(deckCell(page, 37)).toHaveClass(/picked/);
      await deckCell(page, 42).click();
      await expect(deckCells(page, '.picked')).toHaveCount(count);
      await expect(deckCell(page, 42)).toHaveClass(/picked/);
    } else {
      await deckCell(page, 42).click();
    }
    await page.locator('#check').click();
    await page.locator('#next').click();
  }
  expect([...seen].sort()).toEqual(['cell', 'column', 'layer', 'row']);
});

test('a right layer on another cell shows the tapped cell and the cell that played', async ({ page }) => {
  await seedQuiz(page);
  const tapped = 42;
  let shown = false;
  for (let i = 0; i < 150 && !shown; i++) {
    const asked = await page.locator('#deck').getAttribute('data-asked');
    await deckCell(page, tapped).click();
    await page.locator('#check').click();
    const played = Number(await deckCells(page, '.last').getAttribute('data-cell'));
    const layerRight = asked === 'layer' && (await page.locator('#card-feedback').textContent())?.includes('right');
    if (layerRight && played !== tapped) {
      await expect(deckCells(page, '.tapped')).toHaveCount(1);
      await expect(deckCell(page, tapped)).toHaveClass(/tapped/);
      await expect(deckCell(page, tapped)).toHaveClass(/right/);
      await expect(deckCell(page, played)).toHaveClass(/last/);
      shown = true;
    }
    await page.locator('#next').click();
  }
  expect(shown, 'a layer card with a right layer came up').toBe(true);
});

test('on a phone, the prompt, Play, the board and Check fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedQuiz(page);
  const box = async (selector: string) => {
    const rect = await page.locator(selector).first().boundingBox();
    if (rect === null) throw new Error(`${selector} is not shown`);
    return rect;
  };
  expect((await box('#card-title')).y).toBeGreaterThanOrEqual(0);
  expect((await box('#play')).y).toBeGreaterThanOrEqual(0);
  const check = await box('#check');
  expect(check.y + check.height).toBeLessThanOrEqual(844);
  const deck = await box('#deck');
  expect(deck.y + deck.height).toBeLessThanOrEqual(844);
  // A deck that is wider than the screen scrolls sideways and stops at each layer.
  const scroll = await page.locator('#deck').evaluate((element) => ({
    mode: element.dataset.mode,
    snap: getComputedStyle(element).scrollSnapType,
    overflows: element.scrollWidth > element.clientWidth,
  }));
  if (scroll.mode === 'scroll') {
    expect(scroll.snap).toContain('x');
    expect(scroll.overflows).toBe(true);
    await expect(page.locator('.train-dot')).toHaveCount(4);
  }
  // Every cell stays large enough to tap.
  expect((await box('#deck .cell')).width).toBeGreaterThanOrEqual(36);
});

test('the sound set menu on the trainer changes the set, keeps it after a reload, and the game uses it too', async ({ page }) => {
  await page.goto('/sound-training');
  const name = page.locator('#sound-set-name');
  const totals = page.locator('#totals');
  // The first row sound: the octave in Classic, pitched (the default), the chord in Harmony.
  const firstRow = page.locator('.train-value[data-item="row-0"]');
  await expect(name).toHaveText('Classic, pitched');
  await expect(firstRow).toContainText('highest');

  const menu = page.locator('#sound-sets');
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await expect(menu).toBeVisible();
  await menu.locator('[data-sound-set="harmony"]').click();
  await expect(menu.locator('[data-sound-set="harmony"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(name).toHaveText('Harmony');
  await expect(totals).toContainText('Harmony sound set');
  await expect(firstRow).toContainText('C major');
  await expect(page.locator('.train-all').first()).toBeVisible();

  await page.reload();
  await expect(name).toHaveText('Harmony');
  await expect(firstRow).toContainText('C major');

  // The game page reads the same setting.
  await page.goto('/');
  await expect(page.locator('#sound-sets [data-sound-set="harmony"]')).toHaveAttribute('aria-pressed', 'true');

  // Classic does not name cells: the menu shows it as the choice, and the trainer trains Cells.
  await page.goto('/sound-training');
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await menu.locator('[data-sound-set="classic"]').click();
  await page.keyboard.press('Escape');
  await expect(name).toHaveText('Classic');
  await expect(totals).toContainText('Cells sound set');
  await expect(totals).toContainText('Classic does not name cells');
  await expect(firstRow).toContainText('marimba');
});

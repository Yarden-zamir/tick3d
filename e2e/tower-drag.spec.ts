import { cell, expect, marks, test } from './fixtures.ts';
import type { Locator, Page } from '@playwright/test';

const friend = { settings: { mode: 'friend', view: 'tower' } };

// The spin that the page stored after the last drag, or undefined before the first one.
const storedSpin = (page: Page): Promise<unknown> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('tick3d.settings') ?? '{}') as { spin?: unknown }).spin);

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('the element has no box');
  return found;
}

async function dragFrom(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y, { steps: 8 });
  await page.mouse.up();
}

test('a drag in the empty stage beside the tower turns it, and a drag on the keypad does not', async ({ open }) => {
  const { page } = await open(friend);
  const reset = page.getByRole('button', { name: 'Reset angle' });
  await expect(reset).toBeDisabled();
  const before = await storedSpin(page);

  const keypadKey = page.getByRole('button', { name: '1', exact: true });
  const key = await box(keypadKey);
  await dragFrom(page, key.x + key.width / 2, key.y + key.height / 2);
  await expect(reset).toBeDisabled();
  expect(await storedSpin(page)).toEqual(before);

  const stage = await box(page.locator('#stage'));
  const board = await box(page.locator('#board'));
  expect(board.x - stage.x, 'the stage has room beside the tower').toBeGreaterThan(40);
  await dragFrom(page, (stage.x + board.x) / 2, board.y + board.height / 3);
  await expect(reset).toBeEnabled();
  const after = await storedSpin(page);
  expect(after).toEqual(expect.any(Number));
  expect(after).not.toEqual(before);
  await expect(marks(page)).toHaveCount(0);
});

test('a drag that starts on a cell turns the tower and places no mark, and a tap places one', async ({ open }) => {
  const { page } = await open(friend);
  const target = await box(cell(page, 0));
  await dragFrom(page, target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole('button', { name: 'Reset angle' })).toBeEnabled();
  await expect(marks(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset angle' }).click();
  await cell(page, 0).click();
  await expect(marks(page)).toHaveCount(1);
});

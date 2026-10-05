import { cell, expect, expectToast, marks, status, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const friend = { settings: { mode: 'friend' } };
// X takes the space diagonal 0, 21, 42, 63. O takes 1, 2, 3, which is no line.
const X_WINS = [0, 1, 21, 2, 42, 3, 63];

async function play(page: Page, cells: readonly number[]): Promise<void> {
  for (const index of cells) await cell(page, index).click();
}

test('hide board: the keypad places a mark by coordinates', async ({ open }) => {
  const { page } = await open(friend);
  await page.getByRole('button', { name: 'Hide board', exact: true }).click();
  await expect(page.locator('#board')).toBeHidden();
  await expect(page.locator('#board-hidden')).toBeVisible();
  const place = page.locator('#coords-place');
  const tap = async (...digits: number[]) => {
    for (const digit of digits) await page.locator(`[data-digit="${digit}"]`).click();
  };
  await tap(1, 1);
  await expect(place).toBeDisabled();
  await tap(1);
  await place.click();
  await expect(marks(page)).toHaveCount(1);
  await tap(1, 1, 1);
  await place.click();
  await expectToast(page, 'That cell is taken');
  await expect(marks(page)).toHaveCount(1);
});

test('hide history shows only the last move, and every mark when the game ends', async ({ open }) => {
  const { page } = await open(friend);
  const toggle = page.getByRole('button', { name: 'Hide history', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await play(page, X_WINS.slice(0, 2));
  await expect(marks(page)).toHaveCount(1);
  await play(page, X_WINS.slice(2));
  await expect(status(page)).toHaveAttribute('data-state', 'won');
  await expect(marks(page)).toHaveCount(X_WINS.length);
});

test('a lock holds through a reload and ends with the game; the local end card has no code', async ({ open }) => {
  const { page } = await open(friend);
  await cell(page, 0).click();
  await page.locator('#lock').click();
  await expect(page.locator('#lock')).toContainText('Locked');
  await page.reload();
  await expect(page.locator('#lock')).toContainText('Locked');
  await expect(page.getByRole('button', { name: 'Tower' })).toBeDisabled();
  await expect(page.locator('#new-game')).toBeDisabled();
  await play(page, X_WINS.slice(1));
  await expect(status(page)).toHaveAttribute('data-state', 'won');
  await expect(page.getByRole('button', { name: 'Flat' })).toBeEnabled();
  await expect(page.locator('#end-card')).toHaveAttribute('open');
  await expect(page.locator('#end-card-image')).toHaveAttribute('alt', /^Player X wins! /);
  await expect(page.locator('#end-card-code-option')).toBeHidden();
  await expect(page.locator('#end-card-link')).toBeChecked();
});

test('time limits: range check, presets, and a change during a game starts with the next game', async ({ open }) => {
  const { page } = await open(friend);
  const box = (kind: 'perGame' | 'perMove') => page.locator(`[data-limit="${kind}"]`);
  const setCustom = async (kind: 'perGame' | 'perMove', value: string) => {
    await box(kind).locator('[data-limit-value]').fill(value);
    await box(kind).locator('[data-limit-value]').press('Tab');
  };
  const summary = page.locator('#clock-summary');
  await expect(summary).toContainText('No time limit');
  await expect(box('perMove').locator('.limit-options')).toBeHidden();

  await box('perMove').locator('[data-limit-on]').check();
  await expect(summary).toContainText('30 s per move');
  await setCustom('perMove', '2');
  await expectToast(page, 'from 3 s to 10 min');
  await expect(box('perMove').getByRole('button', { name: '30s' })).toHaveAttribute('aria-pressed', 'true');
  // A short limit keeps the timeout below short. A limit under 5 s can end the game before the change below.
  await setCustom('perMove', '5');
  await expect(summary).toContainText('5 s per move');

  await box('perGame').locator('[data-limit-on]').check();
  await box('perGame').getByRole('button', { name: '1m' }).click();
  await expect(box('perGame').getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'true');
  await setCustom('perGame', '1.5');
  await expect(summary).toContainText('1 min 30 s per player');

  // The clock starts after both players moved once.
  await play(page, [0, 1]);
  await box('perGame').getByRole('button', { name: '3m' }).click();
  await expectToast(page, 'starts with the next game');
  await expect(summary).toContainText('Next game: 3 min per player');
  await expect(status(page)).toHaveAttribute('data-state', 'timeout');

  await page.locator('#end-card-close').click();
  await page.locator('#new-game').click();
  await expect(summary).toContainText('3 min per player + 5 s per move');
  await page.reload();
  await expect(summary).toContainText('3 min per player + 5 s per move');
});

import { cell, expect, expectToast, marks, status, test } from './fixtures.ts';
import { DB_NAME } from '../src/device-db.ts';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
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
  // Every match setting and the view wait for the end of the game.
  for (const control of [
    page.getByRole('button', { name: 'Flat' }),
    page.getByRole('button', { name: 'Computer', exact: true }),
    page.getByRole('button', { name: 'Hide board', exact: true }),
    page.locator('[data-limit="perMove"] [data-limit-on]'),
    page.locator('#new-game'),
    page.locator('#undo'),
  ]) {
    await expect(control).toBeDisabled();
  }
  // Leaving stays possible: Home asks first, as in any game with moves.
  await page.locator('#home-link').click();
  await expect(page.locator('#home-confirm')).toHaveAttribute('open');
  await page.locator('#home-confirm-stay').click();
  // The theme and the sound stay free.
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sound', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await play(page, X_WINS.slice(1));
  await expect(status(page)).toHaveAttribute('data-state', 'won');
  await expect(page.getByRole('button', { name: 'Flat' })).toBeEnabled();
  await expect(page.locator('#lock')).not.toContainText('Locked');
  await expect(page.locator('#end-card')).toHaveAttribute('open');
  await expect(page.locator('#end-card-image')).toHaveAttribute('alt', /^Player X wins! /);
  await expect(page.locator('#end-card-code-option')).toBeHidden();
  await expect(page.locator('#end-card-link')).toBeChecked();
  await page.locator('#end-card-close').click();
  // After the game, the result card takes the place of Undo.
  await expect(page.locator('#undo')).toBeHidden();
  await page.getByRole('button', { name: 'Result card' }).click();
  await expect(page.locator('#end-card')).toHaveAttribute('open');
});

test('My games lists the games of this session, with Replay and the result card', async ({ open }) => {
  const { page } = await open(friend);
  await play(page, X_WINS);
  await page.locator('#end-card-close').click();
  await page.locator('#new-game').click();
  await page.locator('#account-button').click();
  const games = page.locator('#my-games-session li');
  await expect(games).toHaveCount(2);
  await expect(games.first()).toContainText('Player X won');
  // The live game has no Replay and no card yet.
  await expect(games.nth(1).getByRole('button')).toHaveCount(0);
  await games.first().getByRole('button', { name: 'Card' }).click();
  await expect(page.locator('#my-games')).not.toHaveAttribute('open');
  await expect(page.locator('#end-card')).toHaveAttribute('open');
  await page.locator('#end-card-close').click();
  await page.locator('#account-button').click();
  await games.first().getByRole('button', { name: 'Replay' }).click();
  await expect(page.locator('#my-games')).not.toHaveAttribute('open');
  await expect(status(page)).toHaveText(`Game 1 · move ${X_WINS.length} of ${X_WINS.length}`);
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

test('the lock shows its tooltip on hover and on a long press, and a short tap still locks', async ({ browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('the config sets no baseURL');
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  await context.addInitScript((key) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ mode: 'friend' }));
  }, STORAGE_KEYS.settings);
  const page = await context.newPage();
  await page.goto('/');
  const lock = page.locator('#lock');
  const tip = page.getByRole('tooltip');
  await expect(lock).toBeEnabled();
  await lock.scrollIntoViewIfNeeded();
  const box = await lock.boundingBox();
  if (box === null) throw new Error('the lock has no box');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // A long press shows the tooltip and does not lock.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(tip).toContainText('no setting changes');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(lock).toHaveAttribute('aria-describedby', 'tip');
  await expect(lock).toHaveAttribute('aria-pressed', 'false');

  // A short tap locks.
  await page.touchscreen.tap(point.x, point.y);
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await context.close();
});

test('icon buttons show their tooltip on hover', async ({ open }) => {
  const { page } = await open(friend);
  await page.locator('#lock').hover();
  await expect(page.getByRole('tooltip')).toContainText('Lock: no setting changes');
  // The hover scrolls the button into view, and a scroll hides the tooltip. The scroll event can come
  // after the hover, so the pointer leaves and hovers again until the tooltip stays.
  await expect(async () => {
    await page.mouse.move(1, 1);
    await page.getByRole('button', { name: 'Sound set', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Sound set', { timeout: 1000 });
  }).toPass();
  await page.mouse.move(1, 1);
  await expect(page.getByRole('tooltip')).toBeHidden();
});

// Runs in the page: keeps a readwrite transaction on the sessions store open, like a frozen tab in the middle of a write.
function holdSessions(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
    request.onsuccess = () => {
      const store = request.result.transaction('sessions', 'readwrite').objectStore('sessions');
      const spin = () => {
        store.get('none').onsuccess = spin;
      };
      spin();
      resolve();
    };
  });
}

test('a tab that holds the game data does not stop a new tab from starting', async ({ open }) => {
  const { page, context } = await open(friend);
  await expect(status(page)).toContainText('to move');
  await page.evaluate(holdSessions, DB_NAME);
  const second = await context.newPage();
  await second.goto('/');
  await expectToast(second, 'Another tick3d tab or app holds the game data');
  await cell(second, 0).click();
  await expect(marks(second)).toHaveCount(1);
});

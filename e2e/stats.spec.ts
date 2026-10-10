import type { Page } from '@playwright/test';
import { expect, playerToken, test } from './fixtures.ts';

// X wins along 0, 16, 32, 48. O plays 1, 2, 3.
const X_WINS = [0, 1, 16, 2, 32, 3, 48];

// Uploads finished games as the page's browser, with its player token: one computer game and one friend game.
async function uploadGames(page: Page): Promise<void> {
  const stored = await page.evaluate(async ({ moves, token }) => {
    const now = Date.now();
    const game = { moves, times: moves.map((_, i) => now - 60_000 + i * 1_000), clock: { perMove: null, perGame: null }, timedOut: false };
    const id = (kind: string) => `e2e-stats-${kind}-${crypto.randomUUID()}`;
    const response = await fetch('/api/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-player': token },
      body: JSON.stringify({
        results: [
          { id: id('computer'), mode: 'computer', game, you: 'X', difficulty: 'easy', finishedAt: now },
          { id: id('friend'), mode: 'friend', game, you: null, difficulty: null, finishedAt: now },
        ],
      }),
    });
    return ((await response.json()) as { stored: number }).stored;
  }, { moves: X_WINS, token: await playerToken(page) });
  expect(stored).toBe(2);
}

const gamesTile = (page: Page) => page.locator('.stats-tile', { has: page.locator('span', { hasText: /^Games$/ }) }).locator('b');

test('Stats in My games opens your own stats, and a filter changes the address and the numbers', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  await uploadGames(page);

  await page.locator('#account-button').click();
  await page.locator('#my-games-stats-link').click();
  await expect(page).toHaveURL(/\/stats\?scope=mine$/);
  await expect(page.getByRole('group', { name: 'Whose games' }).getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
  await expect(gamesTile(page)).toHaveText('2');

  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Computer' }).click();
  await expect(page).toHaveURL(/\/stats\?scope=mine&mode=computer$/);
  await expect(gamesTile(page)).toHaveText('1');

  // The view survives a reload.
  await page.reload();
  await expect(page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Computer' })).toHaveAttribute('aria-pressed', 'true');
  await expect(gamesTile(page)).toHaveText('1');
});

test('the stats API refuses an unknown filter', async ({ request }) => {
  expect((await request.get('/api/stats?range=1y')).status()).toBe(400);
  expect((await request.get('/api/stats?mode=online&level=hard')).status()).toBe(400);
  expect((await request.get('/api/stats?scope=mine')).status()).toBe(400);
});

test('the leaderboard loads on scroll, marks your row, sorts by a column, and opens a player', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  // A medium game: no other test views this filter, so no cached answer from before the upload hides it.
  const stored = await page.evaluate(async ({ moves, token }) => {
    const now = Date.now();
    const game = { moves, times: moves.map((_, i) => now - 60_000 + i * 1_000), clock: { perMove: null, perGame: null }, timedOut: false };
    const result = { id: `e2e-board-${crypto.randomUUID()}`, mode: 'computer', game, you: 'X', difficulty: 'medium', finishedAt: now };
    const response = await fetch('/api/results', { method: 'POST', headers: { 'content-type': 'application/json', 'x-player': token }, body: JSON.stringify({ results: [result] }) });
    return ((await response.json()) as { stored: number }).stored;
  }, { moves: X_WINS, token: await playerToken(page) });
  expect(stored).toBe(1);

  await page.goto('/stats?mode=computer&level=medium');
  const board = page.locator('.stats-card', { has: page.getByRole('heading', { name: 'Leaderboard' }) });
  await board.scrollIntoViewIfNeeded();
  const you = board.locator('.leaderboard-you');
  await expect(you).toBeVisible();

  const fastest = board.locator('th', { hasText: 'Fastest win' });
  await fastest.getByRole('button').click();
  await expect(fastest).toHaveAttribute('aria-sort', 'ascending');
  await fastest.getByRole('button').click();
  await expect(fastest).toHaveAttribute('aria-sort', 'descending');

  await you.locator('.leaderboard-name').click();
  await expect(page).toHaveURL(/person=[0-9a-f]+/);
  await expect(page.locator('#stats-person')).toBeVisible();
});

test('the leaderboard API takes the range, mode and level filters only', async ({ request }) => {
  expect((await request.get('/api/leaderboard?range=30d&mode=computer&level=hard')).status()).toBe(200);
  expect((await request.get('/api/leaderboard?scope=mine')).status()).toBe(400);
  expect((await request.get('/api/leaderboard?person=0123456789abcdef')).status()).toBe(400);
});

import type { Page } from '@playwright/test';
import { CELL_COUNT } from '../src/game.ts';
import { PAGES } from '../src/pages.ts';
import { parseDeviceGameId } from '../src/protocol.ts';
import { cell, createOnline, expect, expectMyMove, expectToast, joinAsO, marks, playComputerUntilEnd, playerToken, status, test } from './fixtures.ts';

// X wins along 0, 16, 32, 48. O plays 1, 2, 3.
const X_WINS = [0, 1, 16, 2, 32, 3, 48];
// Scattered moves that build no line of their own, so the computer wins (as in end-card.spec.ts).
const SCATTERED = [0, 63, 3, 60, 12, 51, 15, 48, 5, 58, 10, 53, 17, 46, 30, 33, 7, 56, 24, 39, 40, 23, 9, 54, 2, 61, 13, 50, 32, 31];
const ORDER = [...SCATTERED, ...Array.from({ length: CELL_COUNT }, (_, i) => i).filter((i) => !SCATTERED.includes(i))];
const RECORD_KEY = 'hard|game:none|move:none|board:false|history:false';

// The game id in the address, once the finished game has its link.
async function gameLink(page: Page): Promise<string> {
  await expect(page).toHaveURL(/[?&]game=[\w-]+/);
  const id = new URL(page.url()).searchParams.get('game');
  if (id === null) throw new Error('the address has no game id');
  return id;
}

async function expectReadOnly(page: Page, title: string | RegExp): Promise<void> {
  await expect(page.locator('#game-view')).toBeVisible();
  await expect(page.locator('#game-view-title')).toHaveText(title);
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#review-exit')).toBeHidden();
  // No moves on a game from a link.
  await cell(page, 20).click();
  await expectToast(page, 'finished game from a link');
}

// Calls the API as the page's browser, with its player token.
const callApi = async (page: Page, path: string) =>
  page.evaluate(
    async ({ path, token }) => {
      const response = await fetch(path, { headers: { 'x-player': token } });
      return (await response.json()) as unknown;
    },
    { path, token: await playerToken(page) },
  );

test('a computer loss gets a link, a server record and a History entry', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'hard', human: 'X' } });
  await playComputerUntilEnd(page, ORDER);
  await expect(status(page)).toHaveText('Computer wins!');
  const moves = await marks(page).count();
  const id = await gameLink(page);
  expect(parseDeviceGameId(id)).toBe(id);
  await page.locator('#end-card-close').click();

  await expect.poll(() => callApi(page, '/api/me/records')).toEqual({ records: { [RECORD_KEY]: moves } });

  await page.locator('#account-button').click();
  const entry = page.locator('#my-games-history li').first();
  await expect(entry).toContainText('Lost · Computer, hard');
  await entry.getByRole('button', { name: 'View' }).click();
  await expect(page.locator('#game-view')).toBeVisible();

  const { page: viewer } = await open({ path: `/?game=${id}` });
  await expectReadOnly(viewer, 'Computer won');
  await expect(viewer.locator('#game-view-details')).toContainText('vs Computer · Hard');
  await expect(viewer.locator('#game-view-players')).toContainText('Computer (O)');
  await expect(viewer.locator('.cell.x, .cell.o')).toHaveCount(moves);
  // Replay steps back through the game.
  await viewer.locator('[data-review="first"]').click();
  await expect(marks(viewer)).toHaveCount(0);

  await viewer.locator('#game-view-play').click();
  await expect(viewer.locator('#game-view')).toBeHidden();
  await expect(viewer).not.toHaveURL(/game=/);
  await expect(status(viewer)).toContainText('Your move');
});

test('a friend game gets a link, and a new game clears it', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  for (const index of X_WINS) await cell(page, index).click();
  await expect(status(page)).toHaveText('Player X wins!');
  const id = await gameLink(page);
  await page.locator('#end-card-new-game').click();
  await expect(page).not.toHaveURL(/game=/);

  const { page: viewer } = await open({ path: `/?game=${id.toLowerCase()}` });
  await expectReadOnly(viewer, 'Player X won');
  await expect(viewer.locator('#game-view-details')).toContainText('Two players, one screen');
});

test('an online game gets the link <CODE>-<n>, which anybody can open, and a cleared history keeps it for the opponent', async ({ open }) => {
  const { page: alice } = await open();
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  for (const [i, index] of X_WINS.entries()) {
    const player = i % 2 === 0 ? alice : bob;
    await expectMyMove(player);
    await cell(player, index).click();
  }
  await expect(status(alice)).toHaveText('You win!');
  expect(await gameLink(alice)).toBe(`${code}-1`);
  expect(new URL(alice.url()).searchParams.get('code')).toBe(code);

  const { page: viewer } = await open({ path: `/?game=${code}-1` });
  await expectReadOnly(viewer, /won$/);
  await expect(viewer.locator('#game-view-details')).toContainText(`game 1 of session ${code}`);

  await bob.locator('#end-card-close').click();
  await bob.locator('#account-button').click();
  await expect(bob.locator('#my-games-history li').first()).toContainText('Lost · Online');

  // Alice clears her history. Bob keeps the shared game.
  await alice.locator('#end-card-close').click();
  await alice.locator('#account-button').click();
  await expect(alice.locator('#my-games-history li').first()).toContainText('Won · Online');
  await alice.locator('#my-games-clear').click();
  await expect(alice.locator('#clear-confirm')).toHaveAttribute('open');
  await alice.locator('#clear-confirm-yes').click();
  await expect(alice.locator('#my-games-history li:not(.empty)')).toHaveCount(0);
  // The clear holds after the dialog loads the history again.
  await alice.locator('#my-games-close').click();
  await alice.locator('#account-button').click();
  await expect(alice.locator('#my-games-history li:not(.empty)')).toHaveCount(0);
  await bob.locator('#my-games-close').click();
  await bob.locator('#account-button').click();
  await expect(bob.locator('#my-games-history li').first()).toContainText('Lost · Online');
});

test('a link to an unknown game shows the problem and starts the page as usual', async ({ open }) => {
  const { page } = await open({ path: '/?game=ZZZZZZZZ' });
  await expectToast(page, 'No game with this link');
  await expect(page).not.toHaveURL(/game=/);
  await expect(page.locator('#game-view')).toBeHidden();
});

// A plain context: the seed script of `open` expects the game page.
test('the stats page shows the numbers, and search engines may list it', async ({ browser, baseURL }) => {
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await context.newPage();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  const response = await page.goto(PAGES.stats.path);
  // The page is public.
  expect(response?.headers()['x-robots-tag']).toBeUndefined();
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  // A card heading means that the numbers came: the placeholder cards have none.
  await expect(page.locator('.stats-card h2').first()).toBeVisible();
  // No page faults and no leaderboards of people in public.
  await expect(page.locator('.stats-card h2', { hasText: /Failures|Slowest thinkers|Survival records/ })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

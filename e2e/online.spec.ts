import { cell, createOnline, expect, expectMyMove, expectToast, joinAsO, marks, ownName, readQr, status, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

// Each test here creates one online session. The server allows 60 new sessions per hour for one
// client address, so keep the count low: this file creates 4.

async function playTurns(turns: readonly (readonly [Page, number])[]): Promise<void> {
  for (const [page, index] of turns) {
    await expectMyMove(page);
    await cell(page, index).click();
    await expect(status(page)).not.toContainText('Your move');
  }
}

// X wins on 0, 16, 32, 48. O plays 1, 2, 3 in between.
const xWins = (alice: Page, bob: Page) =>
  [
    [alice, 0],
    [bob, 1],
    [alice, 16],
    [bob, 2],
    [alice, 32],
    [bob, 3],
    [alice, 48],
  ] as const;

test('two players play a full game, and a watcher replays it', async ({ open, baseURL }) => {
  const { page: alice } = await open();
  const aliceName = await ownName(alice);
  const code = await createOnline(alice);
  await expect(alice.locator('#online-code')).toHaveText(code);
  await expect(status(alice)).toContainText('Waiting');

  await alice.locator('#share-qr').click();
  const link = await readQr(alice.locator('#online-qr-image'));
  expect(link).toBe(new URL(`/?code=${code}`, baseURL).href);
  await expect(alice.locator('#online-qr-caption')).toContainText(code);
  await alice.locator('#share-qr').click();
  await expect(alice.locator('#online-qr')).toBeHidden();

  const { page: bob } = await joinAsO(open, link);
  expect(new URL(bob.url()).searchParams.get('code')).toBe(code);
  await expect(status(alice)).toHaveText('Your move (X)');

  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);
  await cell(alice, 5).click();
  await expectToast(alice, 'not your turn');
  await cell(bob, 0).click();
  await expectToast(bob, 'That cell is taken');

  // Bob sees Alice by her generated name: in the score, the chat and the status.
  await expect(bob.locator('.tally.X')).toContainText(aliceName);
  await alice.locator('#chat-input').fill('good luck');
  await alice.locator('#chat-input').press('Enter');
  await expect(bob.locator('#chat-log')).toContainText(aliceName);
  await playTurns(xWins(alice, bob).slice(1));
  await expect(status(alice)).toHaveText('You win!');
  await expect(status(bob)).toHaveText(`${aliceName} wins!`);
  await expect(bob.locator('.cell.win')).toHaveCount(4);
  for (const page of [alice, bob]) {
    await expect(page.locator('#end-card')).toHaveAttribute('open');
    await expect(page.locator('#end-card-code')).toBeChecked();
    await page.locator('#end-card-close').click();
  }

  await bob.locator('#session-name').fill('Friday rematch');
  await bob.locator('#session-name').press('Enter');
  await expect(alice.locator('#session-name')).toHaveValue('Friday rematch');
  await bob.locator('#new-game').click();
  await expect(alice.locator('#my-games-session li')).toHaveCount(2);
  await expect(bob.locator('#my-games-session li')).toHaveCount(2);

  // The join box is in the Online mode only. A page that starts in the Online mode creates no session.
  const { page: carol } = await open({ settings: { mode: 'online' } });
  await carol.locator('#join-code').fill(code.toLowerCase());
  await carol.locator('#join-code').press('Enter');
  await expect(status(carol)).toContainText('Watching');
  await expect(carol.locator('#session-name')).toHaveValue('Friday rematch');
  // The games of the session are in My games. Replay closes the dialog and shows the game on the board.
  await carol.locator('#account-button').click();
  await carol.locator('#my-games-session li').first().getByRole('button', { name: 'Replay' }).click();
  await expect(carol.locator('#my-games')).not.toHaveAttribute('open');
  await expect(status(carol)).toContainText('move 7 of 7');
  await carol.locator('[data-review="prev"]').click();
  await expect(marks(carol)).toHaveCount(6);
  await cell(carol, 10).click();
  await expectToast(carol, 'You are looking at an old');
  await carol.locator('[data-review="exit"]').click();
  await cell(carol, 10).click();
  await expectToast(carol, 'You are watching');

  await bob.reload();
  await expect(status(bob)).toContainText(`${aliceName}'s move`);
});

test('hide options and the lock belong to the session', async ({ open }) => {
  const { page: alice } = await open();
  const code = await createOnline(alice);
  // A lock waits for the second player: without one, the game could never end.
  await expect(alice.locator('#lock')).toBeDisabled();
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await expect(alice.locator('#lock')).toBeEnabled();
  const { page: carol } = await open({ path: `/?code=${code}` });
  await expect(status(carol)).toContainText('Watching');
  const hideBoard = (page: Page) => page.getByRole('button', { name: 'Hide board', exact: true });
  const hideHistory = (page: Page) => page.getByRole('button', { name: 'Hide history', exact: true });

  await hideBoard(alice).click();
  await expect(bob.locator('#board')).toBeHidden();
  await expectToast(bob, 'Hide board is on for both');
  await expect(carol.locator('#board')).toBeHidden();
  await expect(hideHistory(carol)).toBeDisabled();
  await expect(carol.locator('#lock')).toBeDisabled();

  await hideBoard(bob).click();
  await expect(alice.locator('#board')).toBeVisible();
  await expect(hideBoard(alice)).toHaveAttribute('aria-pressed', 'false');
  await hideHistory(bob).click();
  await expect(hideHistory(alice)).toHaveAttribute('aria-pressed', 'true');
  const hideCoordinates = (page: Page) => page.getByRole('button', { name: 'Hide coordinates', exact: true });
  await hideCoordinates(alice).click();
  await expectToast(bob, 'Hide coordinates is on for both');
  await expect(hideCoordinates(bob)).toHaveAttribute('aria-pressed', 'true');
  await expect(bob.locator('#train-link')).toHaveClass(/highlight/);

  // The view stays per screen.
  await alice.getByRole('button', { name: 'Flat' }).click();
  await expect(bob.locator('#board')).toHaveClass(/tower/);

  await bob.locator('#lock').click();
  await expect(alice.locator('#lock')).toContainText('Locked');
  await expectToast(alice, 'locked for both players');
  for (const control of [hideBoard(alice), alice.getByRole('button', { name: 'Tower' }), alice.getByRole('button', { name: 'Computer' }), alice.locator('#join-code'), hideHistory(bob)]) {
    await expect(control).toBeDisabled();
  }
  // A watcher sees the lock, but keeps its own settings, so the lock never traps a watcher.
  await expect(carol.locator('#lock')).toContainText('Locked');
  await expect(carol.getByRole('button', { name: 'Flat' })).toBeEnabled();
  const refused = await alice.evaluate(async (sessionCode) => {
    const response = await fetch(`/api/sessions/${sessionCode}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-player': localStorage.getItem('tick3d.player') ?? '' },
      body: JSON.stringify({ hideHistory: false }),
    });
    return response.status;
  }, code);
  expect(refused, 'the server refuses an option change during a lock').toBe(409);

  await playTurns(xWins(alice, bob));
  // The winner's name is the one in the other player's score tile.
  const aliceName = await bob.locator('.tally.X span').innerText();
  expect(aliceName).not.toMatch(/^(You|Player X)$/);
  await expect(status(bob)).toHaveText(`${aliceName} wins!`);
  await expect(bob.locator('#lock')).not.toContainText('Locked');
  await expect(hideBoard(bob)).toBeEnabled();
  await expect(alice.getByRole('button', { name: 'Tower' })).toBeEnabled();
  await expect(marks(bob)).toHaveCount(7);
});

test('an away player keeps the seat, and the game waits for the move', async ({ open }) => {
  const { page: alice } = await open();
  const code = await createOnline(alice);
  const bob = await joinAsO(open, `/?code=${code}`);
  await cell(alice, 0).click();
  await expect(marks(bob.page)).toHaveCount(1);
  const storageState = await bob.context.storageState();
  await bob.context.close();

  await expect(status(alice)).toContainText('away');
  await expect(alice.locator('.tally.O.away')).toHaveCount(1);
  await cell(alice, 5).click();
  await expectToast(alice, 'not your turn');

  const { page: bobBack } = await open({ path: `/?code=${code}`, storageState });
  await expectMyMove(bobBack);
  await expect(marks(bobBack)).toHaveCount(1);
  await expect(status(alice)).not.toContainText('away');
  await cell(bobBack, 1).click();
  await expect(marks(alice)).toHaveCount(2);
});

test('the session clock reaches both players, and the server decides a timeout', async ({ open }) => {
  const { page: alice } = await open();
  const perMove = (page: Page) => page.locator('[data-limit="perMove"]');
  await perMove(alice).locator('[data-limit-on]').check();
  await perMove(alice).locator('[data-limit-value]').fill('5');
  await perMove(alice).locator('[data-limit-value]').press('Tab');
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await expect(bob.locator('#clock-summary')).toContainText('5 s per move');
  await expect(bob.locator('#clocks')).toBeVisible();

  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);
  // The per-game switch starts at its default of 5 minutes.
  await bob.locator('[data-limit="perGame"] [data-limit-on]').check();
  await expectToast(alice, 'for the next game');
  await expect(alice.locator('#clock-summary')).toContainText('Next game: 5 min per player + 5 s per move');

  // The first move of each player is untimed. Bob then lets his clock run out.
  await cell(bob, 1).click();
  await expect(marks(alice)).toHaveCount(2);
  await cell(alice, 2).click();
  await expect(status(alice)).toContainText('ran out of time. You win!');
  await expect(status(bob)).toHaveText('You ran out of time.');

  const late = await bob.evaluate(async (sessionCode) => {
    const response = await fetch(`/api/sessions/${sessionCode}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-player': localStorage.getItem('tick3d.player') ?? '' },
      body: JSON.stringify({ game: 0, moveCount: 3, cell: 9 }),
    });
    return response.status;
  }, code);
  expect(late, 'the server refuses a move after the timeout').toBe(409);

  for (const page of [alice, bob]) {
    await expect(page.locator('#end-card')).toHaveAttribute('open');
    await page.locator('#end-card-close').click();
  }
  await perMove(alice).locator('[data-limit-on]').uncheck();
  await expect(bob.locator('#clock-summary')).toContainText('5 min per player');
  await bob.locator('#new-game').click();
  await expect(alice.locator('#my-games-session li')).toHaveCount(2);
  await expect(alice.locator('[data-clock="X"]')).toContainText('5:00');
});

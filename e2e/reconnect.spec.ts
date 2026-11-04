import { cell, createOnline, expect, expectToast, joinAsO, marks, playTurns, status, test, xWins } from './fixtures.ts';
import type { BrowserContext, Page } from '@playwright/test';

// This file creates three online sessions. The server allows 60 new sessions per hour for one client address.

// The page plays over one WebSocket (src/socket.ts). These tests break it, as a deploy or a network change does.
const SOCKET = '**/api/ws*';

// The first `times` sockets of the page close at once, as while the server restarts for a deploy. Later sockets reach
// the server. The page opens a new socket after a wait, and loads the session again.
async function failStreams(page: Page, times: number): Promise<{ count: () => number }> {
  let count = 0;
  await page.routeWebSocket(SOCKET, (socket) => {
    if (count < times) {
      count++;
      socket.close();
      return;
    }
    socket.connectToServer();
  });
  return { count: () => count };
}

// Keeps every WebSocket of the page, so a test can end them (dropStreams). Runs before the app.
function recordStreams(): void {
  const sockets: WebSocket[] = [];
  (window as unknown as { e2eSockets: WebSocket[] }).e2eSockets = sockets;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  };
}

// The socket of the page fails for good, now and later: the open one closes, and each new one closes at once.
// The page gets no change from the server any more, unless it reads the session.
async function dropStreams(page: Page): Promise<void> {
  await page.routeWebSocket(SOCKET, (socket) => socket.close());
  await page.evaluate(() => {
    for (const socket of (window as unknown as { e2eSockets: WebSocket[] }).e2eSockets) socket.close();
  });
}

// Loads the page again, so it keeps its sockets for dropStreams.
async function recorded({ page, context }: { page: Page; context: BrowserContext }): Promise<Page> {
  await context.addInitScript(recordStreams);
  await page.reload();
  return page;
}

// The page goes to the background and comes back, as when a phone locks and unlocks.
async function hideAndShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible'] as const) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}

test('a page whose live stream failed opens a new one, and sees the moves of the other player', async ({ open }) => {
  const { page: alice } = await open();
  const failed = await failStreams(alice, 1);
  const code = await createOnline(alice);
  await expect.poll(failed.count).toBe(1);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  // Alice learns of Bob only through a new stream.
  await expect(status(alice)).toHaveText('Your move (X)');
  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);
  await cell(bob, 1).click();
  await expect(marks(alice)).toHaveCount(2);
});

test('after a new game swapped the seats behind a dead stream, the page shows the new seat when it comes back', async ({ open }) => {
  const alice = await recorded(await open());
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await playTurns(xWins(alice, bob));
  for (const page of [alice, bob]) await page.locator('#end-card-close').click();

  // Alice loses the stream for good, and goes away. Bob starts the next game, so the seats swap: Bob plays X.
  await dropStreams(alice);
  await bob.locator('#new-game').click();
  await expect(status(bob)).toContainText('Your move (X)');
  // The page shows the move before the server has it. Alice must read the session after the server stored it.
  const moved = bob.waitForResponse((response) => response.url().endsWith(`/api/sessions/${code}/moves`) && response.ok());
  await cell(bob, 5).click();
  await moved;

  // Alice comes back. The page reads the session again: she plays O now, and sees Bob's move.
  await hideAndShow(alice);
  await expectToast(alice, 'You play O now.');
  await expect(marks(alice)).toHaveCount(1);
  await expect(status(alice)).toHaveText('Your move (O)');
  await cell(alice, 6).click();
  await expect(marks(bob)).toHaveCount(2);
});

test('a move that the page refuses as not its turn reads the session again, so a stale page can play', async ({ open }) => {
  const alice = await recorded(await open());
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);

  // Alice gets no change any more. She does not see Bob's move, so her page thinks that Bob is still to move.
  await dropStreams(alice);
  await cell(bob, 1).click();
  await expect(status(alice)).not.toContainText('Your move');

  // Her tap is refused, and the page reads the session. Then her move goes through.
  await cell(alice, 2).click();
  await expect(marks(alice)).toHaveCount(2);
  await expect(status(alice)).toHaveText('Your move (X)');
  await cell(alice, 2).click();
  await expect(marks(bob)).toHaveCount(3);
});

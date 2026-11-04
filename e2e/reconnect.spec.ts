import { callApi, cell, createOnline, expect, expectToast, joinAsO, marks, playTurns, status, test, xWins } from './fixtures.ts';
import type { BrowserContext, Page } from '@playwright/test';

// This file creates three online sessions. The server allows 60 new sessions per hour for one client address.

// The page plays over one WebSocket (src/socket.ts). These tests break it, as a deploy or a network change does.
// A socket route takes effect for the WebSockets of a document that loads after it, so each helper loads the page again.
const SOCKET = /\/api\/ws(\?|$)/;

// The first `times` sockets of the page close at once, as while the server restarts for a deploy. Later sockets reach
// the server. The page opens a new socket after a wait, and loads the session again.
async function failStreams(page: Page, times: number): Promise<{ count: () => number }> {
  let count = 0;
  await page.routeWebSocket(SOCKET, (socket) => {
    if (count < times) {
      count++;
      void socket.close();
      return;
    }
    socket.connectToServer();
  });
  await page.reload();
  return { count: () => count };
}

// The pages whose sockets fail now (dropStreams, socketsDown).
const dropped = new WeakSet<Page>();
// The HTTP event stream, the fallback of a page whose socket counts as blocked (src/socket.ts).
const EVENTS = '**/api/sessions/*/events*';

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

// Every live channel of the page fails for good, now and later: the open socket closes, each new one closes at once,
// and the HTTP event stream (the fallback) answers 502. So the page gets no change from the server any more, unless it
// reads the session itself. This freezes a stale page on purpose; no test depends on how fast a channel gives up.
async function dropStreams(page: Page): Promise<void> {
  await page.route(EVENTS, (route) => route.fulfill({ status: 502, body: 'Bad Gateway' }));
  await socketsDown(page);
}

// The sockets of the page fail until socketsUp: the open one closes, and each new one closes at once.
async function socketsDown(page: Page): Promise<void> {
  dropped.add(page);
  await page.evaluate(() => {
    for (const socket of (window as unknown as { e2eSockets: WebSocket[] }).e2eSockets) socket.close();
  });
}

function socketsUp(page: Page): void {
  dropped.delete(page);
}

// Loads the page again with its sockets recorded and routed, so dropStreams can end them.
async function recorded({ page, context }: { page: Page; context: BrowserContext }): Promise<Page> {
  await context.addInitScript(recordStreams);
  await page.routeWebSocket(SOCKET, (socket) => {
    if (dropped.has(page)) void socket.close();
    else socket.connectToServer();
  });
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
  await cell(bob, 5).click();
  await expect
    .poll(async () => ((await callApi(bob, `/api/sessions/${code}`)) as { games: { moves: number[] }[] }).games.at(-1)?.moves.length)
    .toBe(1);

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

test('a move made while the socket is down shows when the socket is back, without a tap', async ({ open }) => {
  const alice = await recorded(await open());
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);

  // Alice's socket goes down. Bob moves meanwhile: no channel tells Alice.
  await socketsDown(alice);
  await cell(bob, 1).click();
  await expect
    .poll(async () => ((await callApi(bob, `/api/sessions/${code}`)) as { games: { moves: number[] }[] }).games[0]?.moves.length)
    .toBe(2);
  await expect(marks(alice)).toHaveCount(1);

  // The socket comes back after its retry wait. The watch starts with a load, so the missed move shows.
  socketsUp(alice);
  await expect(marks(alice)).toHaveCount(2);
  await expect(status(alice)).toHaveText('Your move (X)');
});

test('a page whose socket keeps failing moves to the event stream, and still sees the moves of the other player', async ({ open }) => {
  const { page: alice } = await open();
  // From the first load on, every socket of Alice closes at once. Playwright opens a routed socket before the close,
  // so the page takes the path after an open: it moves to the HTTP event stream after 5 failures in a row (src/socket.ts),
  // about 15 s of retry waits.
  await alice.routeWebSocket(SOCKET, (socket) => void socket.close());
  await alice.reload();
  const code = await createOnline(alice);
  const { page: bob } = await joinAsO(open, `/?code=${code}`);
  // Alice's own moves go over HTTP at once, while her socket is down.
  await cell(alice, 0).click();
  await expect(marks(bob)).toHaveCount(1);
  await cell(bob, 1).click();
  await expect(marks(alice)).toHaveCount(2, { timeout: 40_000 });
  await cell(alice, 2).click();
  await expect(marks(bob)).toHaveCount(3);
  // Later moves of Bob come through the event stream at once.
  await cell(bob, 3).click();
  await expect(marks(alice)).toHaveCount(4);
});

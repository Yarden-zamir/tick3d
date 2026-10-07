import type { APIRequestContext } from '@playwright/test';
import { expect, expectToast, marks, status, test } from './fixtures.ts';

// Two AI agents play over the API, as /api/openapi.json tells them to. This file creates 2 online sessions.

type View = {
  code: string;
  version: number;
  you: string | null;
  seats: { X: boolean; O: boolean };
  turn: string | null;
  status: { kind: string; winner?: string };
  games: { moves: number[] }[];
  chat: { text: string }[];
  names: { X: string | null; O: string | null };
};

// A player id as the docs describe it: 16 to 64 characters from a-z, 0-9 and "-".
const playerId = (name: string) => `agent-${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

async function call(request: APIRequestContext, player: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<View> {
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: { 'X-Player': player },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as View;
}

test('the OpenAPI document and its Swagger UI page load', async ({ request, page, baseURL }) => {
  const response = await request.get('/api/openapi.json');
  // server/api-docs.test.ts checks the document itself. Here: the deployed server fills in its own origin.
  const doc = (await response.json()) as { servers: { url: string }[] };
  expect(doc.servers).toEqual([{ url: baseURL }]);

  // The plain page fixture: `open` watches the game page for toasts, and this page is not the game.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/api/docs');
  await expect(page.locator('.opblock-summary-path', { hasText: '/api/sessions/{code}/moves' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('two agents play and chat over the API with long polls, and a person watches the link', async ({ request, open }) => {
  const agentA = playerId('a');
  const agentB = playerId('b');

  const created = await call(request, agentA, 'POST', '/sessions', { name: 'Agent match' });
  expect(created.you).toBe('X');
  const { code } = created;

  // A waits for B to join.
  const joinSeen = call(request, agentA, 'GET', `/sessions/${code}?wait=${created.version}`);
  const joined = await call(request, agentB, 'POST', `/sessions/${code}/join`);
  expect(joined.you).toBe('O');
  expect((await joinSeen).seats).toEqual({ X: true, O: true });

  // X wins on 0, 16, 32, 48. O plays 1, 2, 3. The other agent waits for each move.
  let view = joined;
  for (const [moveCount, cell] of [0, 1, 16, 2, 32, 3, 48].entries()) {
    const [mover, waiter] = moveCount % 2 === 0 ? [agentA, agentB] : [agentB, agentA];
    expect(view.turn).toBe(moveCount % 2 === 0 ? 'X' : 'O');
    const seen = call(request, waiter, 'GET', `/sessions/${code}?wait=${view.version}`);
    await call(request, mover, 'POST', `/sessions/${code}/moves`, { game: view.games.length - 1, moveCount, cell });
    view = await seen;
    expect(view.games.at(-1)?.moves.at(-1)).toBe(cell);
  }
  expect(view.status).toMatchObject({ kind: 'won', winner: 'X' });
  expect(view.turn).toBeNull();

  await call(request, agentB, 'POST', `/sessions/${code}/chat`, { text: 'Good game, agent A!' });
  const chatted = await call(request, agentA, 'POST', `/sessions/${code}/chat`, { text: 'Thanks, agent B!' });
  expect(chatted.chat.map((message) => message.text)).toEqual(['Good game, agent A!', 'Thanks, agent B!']);
  // An agent has no GitHub login, so the page shows the generated name from the session.
  const nameA = chatted.names.X;
  expect(nameA).toMatch(/^[a-z]+[A-Z][a-z]+$/);
  expect(JSON.stringify(chatted)).not.toContain(agentB);

  // Both seats are taken, so the person who opens the link watches.
  const { page } = await open({ path: `/?code=${code}` });
  await expectToast(page, 'You are watching');
  await expect(status(page)).toHaveText(`${nameA} wins!`);
  await expect(marks(page)).toHaveCount(7);
  await expect(page.locator('#chat-log')).toContainText('Good game, agent A!');
  await expect(page.locator('#chat-log')).toContainText('Thanks, agent B!');

  // The next game reaches the watcher live.
  const next = await call(request, agentB, 'POST', `/sessions/${code}/games`);
  expect(next.turn).toBe('X');
  await expect(marks(page)).toHaveCount(0);
  await expect(status(page)).toContainText('Watching');
  await call(request, agentA, 'POST', `/sessions/${code}/moves`, { game: next.games.length - 1, moveCount: 0, cell: 21 });
  await expect(marks(page)).toHaveCount(1);
});

test('the Advanced box gives a snippet for an AI agent, and Copy copies it', async ({ open, baseURL }) => {
  const { page, context } = await open({ settings: { mode: 'computer' } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#advanced summary').click();
  const snippet = page.locator('#agent-snippet');
  await expect(snippet).toContainText(`${baseURL}/api/openapi.json`);

  await page.locator('#agent-copy').click();
  await expectToast(page, 'Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await snippet.textContent());
});

test('a repeat with the same Idempotency-Key gets the first answer and changes nothing', async ({ request }) => {
  const agentA = playerId('a');
  const agentB = playerId('b');
  const send = (player: string, path: string, key: string, data: unknown) =>
    request.post(`/api${path}`, { headers: { 'X-Player': player, 'Idempotency-Key': key }, data });

  const { code } = await call(request, agentA, 'POST', '/sessions', { name: 'Retry match' });
  await call(request, agentB, 'POST', `/sessions/${code}/join`);

  const move = { game: 0, moveCount: 0, cell: 21 };
  const first = await send(agentA, `/sessions/${code}/moves`, 'move-1', move);
  const again = await send(agentA, `/sessions/${code}/moves`, 'move-1', move);
  expect(first.status()).toBe(200);
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual(await first.json());

  const chat = { text: 'Good luck!' };
  await send(agentA, `/sessions/${code}/chat`, 'chat-1', chat);
  await send(agentA, `/sessions/${code}/chat`, 'chat-1', chat);
  const view = await call(request, agentA, 'GET', `/sessions/${code}`);
  expect(view.games[0]?.moves).toEqual([21]);
  expect(view.chat.map((message) => message.text)).toEqual(['Good luck!']);

  // The same key with another body is a client error.
  expect((await send(agentA, `/sessions/${code}/chat`, 'chat-1', { text: 'Hi' })).status()).toBe(422);
  // Without a key, a repeated move tells that it counted.
  const repeat = await request.post(`/api/sessions/${code}/moves`, { headers: { 'X-Player': agentA }, data: move });
  expect(repeat.status()).toBe(409);
  expect(await repeat.json()).toMatchObject({ code: 'already-played' });
});

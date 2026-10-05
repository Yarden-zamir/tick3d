import type { APIRequestContext } from '@playwright/test';
import { expect, expectToast, marks, status, test } from './fixtures.ts';

// Two AI agents play over the API, as /api/openapi.json tells them to. This file creates 1 online session.

type View = {
  code: string;
  version: number;
  you: string | null;
  seats: { X: boolean; O: boolean };
  turn: string | null;
  status: { kind: string; winner?: string };
  games: { moves: number[] }[];
  chat: { text: string }[];
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

test('the OpenAPI document and its Swagger UI page load', async ({ request, open, baseURL }) => {
  const response = await request.get('/api/openapi.json');
  const doc = (await response.json()) as { openapi: string; info: { description: string }; servers: { url: string }[]; paths: Record<string, unknown> };
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.servers).toEqual([{ url: baseURL }]);
  expect(Object.keys(doc.paths)).toContain('/api/sessions/{code}/moves');
  expect(doc.info.description).toContain('## Quick start');
  expect((await request.get('/api/docs.md')).status()).toBe(404);

  const { page } = await open({ path: '/api/docs' });
  await expect(page.locator('.swagger-ui .info .title')).toContainText('tick3d HTTP API');
  await expect(page.locator('.opblock-summary-path', { hasText: '/api/sessions/{code}/moves' })).toBeVisible();
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

  // Both seats are taken, so the person who opens the link watches.
  const { page } = await open({ path: `/?code=${code}` });
  await expectToast(page, 'You are watching');
  await expect(status(page)).toHaveText('Player X wins!');
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
  await expect(snippet).toContainText('wait for my instructions');

  await page.locator('#agent-copy').click();
  await expectToast(page, 'Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await snippet.textContent());
});

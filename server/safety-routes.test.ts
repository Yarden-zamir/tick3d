// The report, block, moderation and delete my data routes, through the real HTTP server (server/main.ts).
// The server runs in a child process on its own port, with GitHub login on and a fake secret.
import { type ChildProcess, spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DATA_DELETES_PER_HOUR, DATA_TABLES, REPORTS_PER_10_MINUTES } from './api-docs.ts';
import { type AuthConfig, createAuth } from './auth.ts';

// Each test makes many requests to a server that runs DuckDB. With the other test files
// running at the same time, the 5 s default timed out now and then (as in server/store.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const PORT = 18_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const config: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  secret: 's'.repeat(40),
  origin: 'https://tick3d.example.com',
  cookieDomain: 'tick3d.example.com',
};
const alice = 'aaaaaaaa-0000-4000-8000-00000000a11c';
const bob = 'bbbbbbbb-0000-4000-8000-0000000000b0';
const dave = 'dddddddd-0000-4000-8000-00000000da7e';
const tokens = [alice, bob, dave];

let server: ChildProcess;

// The account cookie of a GitHub login, made by the real login flow against a fake GitHub.
async function loginCookie(id: number, login: string): Promise<string> {
  const github = (async (url: string) =>
    new Response(JSON.stringify(url.includes('access_token') ? { access_token: 'gho_test' } : { id, login, avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` }))) as typeof fetch;
  const auth = createAuth(config, github);
  const start = auth.start(config.origin, null);
  const nonce = start.cookies[0]?.split(';')[0] ?? '';
  const request = { headers: { cookie: nonce } } as unknown as IncomingMessage;
  const done = await auth.finish(request, 'code', new URL(start.location).searchParams.get('state'));
  const account = done.cookies.find((cookie) => cookie.startsWith('t3_user='));
  if (account === undefined) throw new Error('the login set no account cookie');
  return account.split(';')[0] ?? '';
}

type Answer = { status: number; body: unknown; text: string; retryAfter: string | null; setCookie: string | null };

async function call(method: string, path: string, options: { player?: string; cookie?: string; body?: unknown; client?: string } = {}): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': options.client ?? '203.0.113.1' };
  if (options.player !== undefined) headers['x-player'] = options.player;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  const response = await fetch(`${BASE}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await response.text();
  // The private player token must never come back, in any answer.
  for (const token of tokens) expect(text).not.toContain(token);
  return { status: response.status, body: JSON.parse(text), text, retryAfter: response.headers.get('retry-after'), setCookie: response.headers.get('set-cookie') };
}

beforeAll(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: ':memory:',
      GITHUB_CLIENT_ID: config.clientId,
      GITHUB_CLIENT_SECRET: config.clientSecret,
      AUTH_SECRET: config.secret,
      AUTH_ORIGIN: config.origin,
      COOKIE_DOMAIN: config.cookieDomain,
    },
    stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await fetch(`${BASE}/health`).then((response) => response.ok, () => false);
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the server did not start');
}, 20_000);

afterAll(() => {
  server.kill();
});

describe('report, block and moderation routes', () => {
  it('stores a report, lists it only for maintainers, and moderates only for maintainers', async () => {
    const created = await call('POST', '/sessions', { player: alice, body: { name: 'Safety' } });
    const code = (created.body as { code: string }).code;
    await call('POST', `/sessions/${code}/join`, { player: bob });
    const chatted = await call('POST', `/sessions/${code}/chat`, { player: bob, body: { text: 'rude words' } });
    const message = (chatted.body as { chat: { id: number; by: string }[] }).chat[0];
    expect(message?.by).toMatch(/^[0-9a-f]{16}$/);

    const report = await call('POST', '/reports', { player: alice, body: { code, message: message?.id, reason: 'abuse', note: 'mean' } });
    expect(report.status).toBe(201);
    expect((await call('POST', '/reports', { player: alice, body: { code, message: message?.id, reason: 'rude' } })).status).toBe(400);

    const maintainer = await loginCookie(1, 'Yarden-zamir');
    const someone = await loginCookie(2, 'octo');
    expect((await call('GET', '/reports', { player: alice })).status).toBe(401);
    expect((await call('GET', '/reports', { player: alice, cookie: someone })).status).toBe(403);
    // Without the X-Player header, the cookie alone does not do: another site cannot send it.
    expect((await call('GET', '/reports', { cookie: maintainer })).status).toBe(400);
    const listed = await call('GET', '/reports', { player: alice, cookie: maintainer });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ reports: [{ code, message: message?.id, text: 'rude words', person: message?.by, reason: 'abuse', note: 'mean' }] });

    expect((await call('DELETE', `/sessions/${code}/chat/${message?.id}`, { player: alice, cookie: someone })).status).toBe(403);
    expect((await call('DELETE', `/sessions/${code}/chat/${message?.id}`, { player: alice, cookie: maintainer })).status).toBe(200);
    const after = await call('GET', `/sessions/${code}`, { player: alice });
    expect((after.body as { chat: { text: string }[] }).chat[0]?.text).not.toBe('rude words');
    expect((await call('PUT', '/me/name', { player: bob, body: { name: 'Rude Name' } })).status).toBe(200);
    expect((await call('DELETE', `/players/${message?.by}/name`, { player: alice, cookie: someone })).status).toBe(403);
    expect((await call('DELETE', `/players/${message?.by}/name`, { player: alice, cookie: maintainer })).status).toBe(200);
    expect((await call('GET', '/me', { player: bob })).body).toMatchObject({ name: null });
    const log = await call('GET', '/reports', { player: alice, cookie: maintainer });
    expect((log.body as { actions: { login: string; action: string }[] }).actions.map((entry) => entry.action)).toEqual(['clear-name', 'hide-message']);
  });

  it('blocks and unblocks by person id, and refuses a block of yourself', async () => {
    const created = await call('POST', '/sessions', { player: alice, body: { name: 'Blocks' } });
    const code = (created.body as { code: string }).code;
    const joined = await call('POST', `/sessions/${code}/join`, { player: bob });
    const people = (joined.body as { people: Record<'X' | 'O', string> }).people;
    const blocked = await call('PUT', `/me/blocks/${people.O}`, { player: alice, body: { name: 'braveOtter' } });
    expect(blocked.body).toMatchObject({ blocked: [{ person: people.O, name: 'braveOtter' }] });
    expect((await call('GET', '/me/blocks', { player: alice })).body).toEqual(blocked.body);
    expect((await call('PUT', `/me/blocks/${people.X}`, { player: alice, body: { name: 'me' } })).status).toBe(400);
    expect((await call('DELETE', `/me/blocks/${people.O}`, { player: alice })).body).toEqual({ blocked: [] });
  });

  it('refuses reports over the limit with Retry-After', async () => {
    const client = '198.51.100.9';
    const body = { code: 'ZZZZ', message: 1, reason: 'spam' };
    // Each one passes the limiter and then finds no session.
    for (let sent = 0; sent < REPORTS_PER_10_MINUTES; sent++) expect((await call('POST', '/reports', { player: alice, body, client })).status).toBe(404);
    const refused = await call('POST', '/reports', { player: alice, body, client });
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });
});

describe('delete my data route', () => {
  it('needs X-Player, deletes the account of a logged-in browser, logs it out, and answers counts without a token', async () => {
    const client = '198.51.100.20';
    const cookie = await loginCookie(7, 'dave');
    expect((await call('DELETE', '/me', { cookie, client })).status).toBe(400);
    await call('PUT', '/me/name', { player: dave, body: { name: 'Dave D' } });
    const created = await call('POST', '/sessions', { player: dave, cookie, body: { name: 'Delete me' } });
    const code = (created.body as { code: string }).code;
    const deleted = await call('DELETE', '/me', { player: dave, cookie, client });
    expect(deleted.status).toBe(200);
    expect(Object.keys(deleted.body as object).sort()).toEqual([...DATA_TABLES].sort());
    expect(deleted.body).toMatchObject({ sessions: { deleted: 1 }, player_names: { deleted: 1 }, player_tokens: { deleted: 2 }, users: { deleted: 1 } });
    expect(deleted.text).not.toContain('dave');
    expect(deleted.setCookie).toMatch(/^t3_user=;.*Max-Age=0/);
    expect((await call('GET', `/sessions/${code}`, { player: dave })).status).toBe(404);
    expect((await call('GET', '/me', { player: dave })).body).toMatchObject({ user: null, name: null });
    // A second call finds nothing.
    const again = await call('DELETE', '/me', { player: dave, client });
    expect(Object.values(again.body as object).every((counts) => counts.deleted === 0 && counts.anonymised === 0)).toBe(true);
  });

  it('refuses deletes over the limit with Retry-After', async () => {
    const client = '198.51.100.21';
    for (let sent = 0; sent < DATA_DELETES_PER_HOUR; sent++) expect((await call('DELETE', '/me', { player: dave, client })).status).toBe(200);
    const refused = await call('DELETE', '/me', { player: dave, client });
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('lets only a maintainer delete the data of a person or an account, for an email request', async () => {
    const created = await call('POST', '/sessions', { player: bob, body: { name: 'Email request' } });
    const person = (created.body as { people: { X: string } }).people.X;
    const maintainer = await loginCookie(1, 'Yarden-zamir');
    const someone = await loginCookie(2, 'octo');
    expect((await call('DELETE', `/players/${person}`, { player: alice })).status).toBe(401);
    expect((await call('DELETE', `/players/${person}`, { player: alice, cookie: someone })).status).toBe(403);
    const deleted = await call('DELETE', `/players/${person}`, { player: alice, cookie: maintainer });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ sessions: { deleted: 1 } });
    expect((await call('DELETE', `/players/${person}`, { player: alice, cookie: maintainer })).status).toBe(404);
    expect((await call('DELETE', '/accounts/octo', { player: alice, cookie: someone })).status).toBe(403);
    expect((await call('DELETE', '/accounts/not%20a%20login', { player: alice, cookie: maintainer })).status).toBe(400);
    expect((await call('DELETE', '/accounts/nobody-here', { player: alice, cookie: maintainer })).status).toBe(404);
  });
});


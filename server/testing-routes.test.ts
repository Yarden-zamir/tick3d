// The tester code routes, through the real HTTP server (server/main.ts) with codes in TESTER_CODES.
import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TESTER_CLAIMS_PER_HOUR } from './api-docs.ts';

// A server that runs DuckDB, next to the other test files (as in server/safety-routes.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const PORT = 19_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const CODES = Array.from({ length: TESTER_CLAIMS_PER_HOUR + 2 }, (_, i) => `CODE${String(i).padStart(19, '0')}`);
const player = 'aaaaaaaa-0000-4000-8000-00000000a11c';

let server: ChildProcess;

async function call(method: string, path: string, options: { player?: string; body?: unknown; client?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': options.client ?? '203.0.113.1' };
  if (options.player !== undefined) headers['x-player'] = options.player;
  const response = await fetch(`${BASE}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  return { status: response.status, body: (await response.json()) as unknown, retryAfter: response.headers.get('retry-after') };
}

const claim = (id: number, client: string, body: unknown = { email: 'dana@example.com', name: 'Dana' }) =>
  call('POST', `/testing/codes/${id}/claim`, { player, body, client });

beforeAll(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    // A local server: no KITSHN_ENVIRONMENT, so it reads TESTER_CODES. The last code was given out by hand.
    env: { ...process.env, PORT: String(PORT), DB_PATH: ':memory:', KITSHN_ENVIRONMENT: '', TESTER_CODES: `${CODES.slice(0, -1).join(',')}\n${CODES.at(-1)}=Tom` },
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

describe('the tester code routes', () => {
  it('list every code by its hint, with the hand-given one taken', async () => {
    const { status, body } = await call('GET', '/testing/codes');
    expect(status).toBe(200);
    const codes = (body as { codes: { id: number; hint: string; claimed: boolean; name: string | null }[] }).codes;
    expect(codes).toHaveLength(CODES.length);
    expect(codes.at(-1)).toMatchObject({ hint: 'COD', claimed: true, name: 'Tom' });
    expect(JSON.stringify(body)).not.toContain(CODES[0]);
  });

  it('give a code once, need the X-Player header and a valid body, and limit the claims per address', async () => {
    expect((await call('POST', '/testing/codes/1/claim', { body: { email: 'dana@example.com', name: 'Dana' }, client: '203.0.113.9' })).status).toBe(400);
    expect((await claim(1, '203.0.113.9', { email: 'nope', name: 'Dana' })).status).toBe(400);
    // An invite needs a person id in `by`.
    expect((await claim(1, '203.0.113.30', { email: 'dana@example.com', name: 'Dana', by: 'not-a-person' })).status).toBe(400);
    expect((await claim(1, '203.0.113.9', { email: 'dana@example.com', name: 'Dana' })).body).toEqual({ code: CODES[0] });
    expect((await claim(1, '203.0.113.9')).status).toBe(409);
    expect((await claim(99, '203.0.113.9')).status).toBe(404);
    expect((await call('POST', '/testing/codes/1e0/claim', { player, body: {}, client: '203.0.113.8' })).status).toBe(400);

    // Another address: the limit counts every request, also the refused ones.
    const client = '203.0.113.20';
    for (let id = 2; id < 2 + TESTER_CLAIMS_PER_HOUR; id++) expect((await claim(id, client)).status).toBe(200);
    const refused = await claim(2 + TESTER_CLAIMS_PER_HOUR, client);
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('refuses a referrer-only app open and fails closed without purchase credentials', async () => {
    const report = (body: unknown) => call('POST', '/copies', { player, body, client: '203.0.113.40' });
    expect((await report({ by: 'nope' })).status).toBe(400);
    expect((await call('POST', '/copies', { body: { by: null }, client: '203.0.113.40' })).status).toBe(400);
    expect((await report({ by: '0123456789abcdef' })).status).toBe(400);
    expect((await report({ by: null, proof: 'invented', store: 'play' })).status).toBe(503);
    // An Apple proof names its device. Without the id, the body is invalid.
    expect((await report({ by: null, proof: 'invented', store: 'apple' })).status).toBe(400);
    expect((await report({ by: null, proof: 'invented', store: 'apple', device: '0f1e2d3c-4b5a-4978-8a6b-000000000001' })).status).toBe(503);
    expect((await call('POST', '/copies/nonce')).status).toBe(400);
    const first = await call('POST', '/copies/nonce', { player });
    const second = await call('POST', '/copies/nonce', { player });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ nonce: expect.any(String) });
    expect(first.body).not.toEqual(second.body);
  });

  it('keep the claims with the emails for the maintainers only', async () => {
    // This server has no GitHub login, so nobody can read the emails.
    expect((await call('GET', '/testing/claims', { player })).status).toBe(404);
    expect((await call('GET', '/testing/claims')).status).toBe(400);
  });
});

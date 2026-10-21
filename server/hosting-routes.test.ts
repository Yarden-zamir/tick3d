// Seed purchase records before starting the real server. There is no test bypass in the API.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore } from './store.ts';
import type { PlayerToken } from '../src/protocol.ts';

const player = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` as PlayerToken;
const port = 20_000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}/api`;
let directory: string;
let server: ChildProcess;
async function call(path: string, token: PlayerToken, body: unknown = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-player': token }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tick3d-hosting-'));
  const path = join(directory, 'hosting.duckdb');
  const store = await openStore(path);
  try {
    await store.reportAppOpen(player(1), null); // An old, unproved copy.
    await store.reportAppOpen(player(2), null, true);
    await store.linkToken(player(2), { id: 1001, login: 'buyer', avatar: 'https://avatars.githubusercontent.com/u/1001' });
    await store.linkToken(player(3), { id: 1001, login: 'buyer', avatar: 'https://avatars.githubusercontent.com/u/1001' });
  } finally {
    await store.close();
  }
  server = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: String(port), DB_PATH: path, LAN_HOST: '', PLAY_SERVICE_ACCOUNT_JSON: '', APPLE_APP_ID: '', APPLE_BUNDLE_ID: '' }, stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`${base}/health`).then((response) => response.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The hosting test server did not start');
}, 20_000);

afterAll(async () => {
  if (server !== undefined) {
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server.kill();
    await exited;
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

describe('public online hosting', () => {
  it('refuses a free player and a legacy copy, even if the client skips the screen', async () => {
    for (const token of [player(0), player(1)]) {
      const response = await call('/sessions', token, { name: 'Bypass attempt' });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('Joining and Nearby stay free') });
    }
  });
  it('allows a proved device and another browser of its account to host; joining stays free', async () => {
    const response = await call('/sessions', player(2), { name: 'Paid host' });
    expect(response.status).toBe(201);
    const session = await response.json() as { code: string };
    expect((await call(`/sessions/${session.code}/join`, player(0))).status).toBe(200);
    expect((await call('/sessions', player(3), { name: 'Account browser' })).status).toBe(201);
  });
  it('does not turn a fabricated app open into hosting permission', async () => {
    expect((await call('/copies', player(4), { store: 'play', proof: 'fake', by: null })).status).toBe(503);
    expect((await call('/sessions', player(4), { name: 'Still free' })).status).toBe(403);
  });
});

// The live stream of a session (GET /api/sessions/{code}/events), through the real HTTP server (server/main.ts).
// The server sends each open page its own new view with a change, so the page needs no GET (#253).
import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The first writes of a new server are slow while the other test files run (as in server/safety-routes.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const PORT = 18_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const alice = 'aaaaaaaa-0000-4000-8000-00000000a11c';
const bob = 'bbbbbbbb-0000-4000-8000-0000000000b0';

let server: ChildProcess;

async function call(method: string, path: string, player: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-player': player },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

// The data of each message of one event stream, as it comes.
type Stream = { messages: string[]; text: () => string; close: () => void };

async function openStream(code: string, player: string): Promise<Stream> {
  const stop = new AbortController();
  const response = await fetch(`${BASE}/sessions/${code}/events?player=${player}&stream=${crypto.randomUUID()}`, { signal: stop.signal });
  if (!response.ok || response.body === null) throw new Error(`the stream did not open: ${response.status}`);
  let raw = '';
  const stream: Stream = { messages: [], text: () => raw, close: () => stop.abort() };
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        raw += decoder.decode(chunk, { stream: true });
        const blocks = raw.split('\n\n');
        stream.messages = blocks.flatMap((block) => (block.startsWith('data: ') ? [block.slice('data: '.length)] : []));
      }
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }
  })();
  return stream;
}

async function viewWith(stream: Stream, version: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const message of stream.messages) {
      if (message === 'changed') continue;
      const view = JSON.parse(message) as Record<string, unknown>;
      if (view.version === version) return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no view of version ${version} came; messages: ${stream.messages.join(' | ')}`);
}

beforeAll(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: ':memory:' },
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

describe('the live stream', () => {
  it("sends each player their own new view after a move, and no other player's token", async () => {
    const code = String((await call('POST', '/sessions', alice, { name: 'Live' })).code);
    await call('POST', `/sessions/${code}/join`, bob);
    const streams = { alice: await openStream(code, alice), bob: await openStream(code, bob) };
    try {
      const before = await call('GET', `/sessions/${code}`, alice);
      const moved = await call('POST', `/sessions/${code}/moves`, alice, { game: 0, moveCount: 0, cell: 0 });
      expect(moved.version).toBeGreaterThan(Number(before.version));
      const views = { alice: await viewWith(streams.alice, Number(moved.version)), bob: await viewWith(streams.bob, Number(moved.version)) };
      expect(views.alice.you).toBe('X');
      expect(views.bob.you).toBe('O');
      // The pushed view is the view that a GET answers.
      const { now: _pushedNow, ...pushed } = views.bob;
      const { now: _readNow, ...read } = await call('GET', `/sessions/${code}`, bob);
      expect(pushed).toEqual(read);
      expect(streams.alice.text()).not.toContain(bob);
      expect(streams.bob.text()).not.toContain(alice);
    } finally {
      streams.alice.close();
      streams.bob.close();
    }
  });
});

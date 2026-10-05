import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { replay } from '../src/game.ts';
import { type Code, type PlayerToken, type ResultUpload, toRecord } from '../src/protocol.ts';
import { SessionError } from '../src/session/core.ts';
import { type Store, openStore } from './store.ts';

const alice = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const bob = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
const carol = 'cccccccc-0000-4000-8000-000000000003' as PlayerToken;
const alicePhone = 'dddddddd-0000-4000-8000-000000000004' as PlayerToken;
const X_WINS = [0, 1, 16, 2, 32, 3, 48];
const ALICE_GITHUB = { id: 101, login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/101?v=4' };

let store: Store;
afterEach(() => store.close());

async function status(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SessionError) return error.status;
    throw error;
  }
  return undefined;
}

async function session(): Promise<Code> {
  store = await openStore(':memory:');
  const { code } = await store.create(alice, 'Friday match');
  await store.join(code, bob);
  return code;
}

async function playMoves(code: Code, cells: number[], game = 0): Promise<void> {
  for (const [moveCount, cell] of cells.entries()) {
    await store.move(code, moveCount % 2 === 0 ? alice : bob, { game, moveCount, cell });
  }
}

function result(id: string, overrides: Partial<ResultUpload> = {}): ResultUpload {
  const game = toRecord(replay(X_WINS, { times: X_WINS.map((_, i) => 1_000 + i) }));
  return { id, mode: 'computer', game, you: 'X', difficulty: 'hard', finishedAt: 2_000, ...overrides };
}

describe('sessions', () => {
  it('creates a session with a 4 character code and the creator as X', async () => {
    store = await openStore(':memory:');
    const view = await store.create(alice, '  Friday match ');
    expect(view.code).toHaveLength(4);
    expect(view).toMatchObject({ name: 'Friday match', you: 'X', seats: { X: true, O: false }, chat: [], players: { X: null, O: null } });
  });

  it('returns 404 for an unknown code', async () => {
    store = await openStore(':memory:');
    expect(await status(() => store.get('ZZZZ' as Code, alice))).toBe(404);
  });

  it('keeps sessions, games and chat after the store reopens the same file', async () => {
    const path = `${await mkdtemp('/tmp/tick3d-store-')}/sessions.duckdb`;
    store = await openStore(path);
    const { code } = await store.create(alice, 'Persistent');
    await store.join(code, bob);
    await store.move(code, alice, { game: 0, moveCount: 0, cell: 5 });
    await store.chat(code, bob, 'hello');
    store.close();
    store = await openStore(path);
    expect(await store.get(code, bob)).toMatchObject({ you: 'O', games: [{ moves: [5] }], chat: [{ from: 'O', text: 'hello' }] });
  });

  it('runs requests that arrive together one after the other', async () => {
    const code = await session();
    const results = await Promise.allSettled([
      store.move(code, alice, { game: 0, moveCount: 0, cell: 0 }),
      store.move(code, alice, { game: 0, moveCount: 0, cell: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.get(code, alice)).games[0]?.moves).toHaveLength(1);
  });

  it('keeps every session: nothing old is deleted', async () => {
    store = await openStore(':memory:');
    const codes: Code[] = [];
    for (let i = 0; i < 30; i++) codes.push((await store.create(alice, `Game ${i}`)).code);
    for (const code of codes) expect((await store.get(code, alice)).code).toBe(code);
    // 60 store calls take about 3 s, and more on a busy build server. If the default 5 s limit
    // returns, check the time per store call first: a slow call is a real problem.
  }, 20_000);

  it('reports every write, also a timeout that a read records', async () => {
    let time = 1_000_000;
    const changed: Code[] = [];
    store = await openStore(':memory:', { now: () => time, onChange: (code) => changed.push(code) });
    const { code } = await store.create(alice, 'Blitz', { perMove: 3, perGame: null });
    await store.join(code, bob);
    await playMoves(code, [0, 1]);
    expect(changed).toEqual([code, code, code]);
    time += 10_000;
    const view = await store.get(code, bob);
    expect(view.games[0]?.timedOut).toBe(true);
    expect(changed).toHaveLength(4);
    await store.get(code, bob);
    expect(changed).toHaveLength(4);
  });

  it('reports presence from the HTTP layer', async () => {
    store = await openStore(':memory:', { presence: () => ({ X: true, O: false }) });
    const { code } = await store.create(alice, 'Present');
    expect((await store.get(code, alice)).presence).toEqual({ X: true, O: false });
  });
});

describe('accounts', () => {
  it('gives a logged-in player their seats on every linked device, with their GitHub name', async () => {
    const code = await session();
    expect((await store.get(code, alicePhone)).you).toBeNull();
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    const fromPhone = await store.get(code, alicePhone);
    expect(fromPhone.you).toBe('X');
    expect(fromPhone.players).toEqual({ X: { login: 'alice', avatar: ALICE_GITHUB.avatar }, O: null });
    await store.move(code, alicePhone, { game: 0, moveCount: 0, cell: 9 });
    expect((await store.get(code, bob)).games[0]?.moves).toEqual([9]);
  });

  it('stops a logged-out browser from acting for the account, and keeps the other devices', async () => {
    const code = await session();
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.unlinkToken(alicePhone);
    expect((await store.get(code, alicePhone)).you).toBeNull();
    expect(await status(() => store.move(code, alicePhone, { game: 0, moveCount: 0, cell: 9 }))).toBe(403);
    expect((await store.myGames(alicePhone)).user).toBeNull();
    expect((await store.get(code, alice)).players.X?.login).toBe('alice');
  });

  it('refreshes a renamed account', async () => {
    const code = await session();
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alice, { ...ALICE_GITHUB, login: 'alice-renamed' });
    expect((await store.get(code, bob)).players.X?.login).toBe('alice-renamed');
  });
});

describe('results', () => {
  it('stores a result once, even when a device sends it again', async () => {
    store = await openStore(':memory:');
    const first = result('11111111-0000-4000-8000-000000000001');
    expect(await store.addResults(alice, [first])).toBe(1);
    expect(await store.addResults(alice, [first, result('11111111-0000-4000-8000-000000000002')])).toBe(1);
    expect((await store.myGames(alice)).byMode.computer.played).toBe(2);
  });

  it('refuses an unfinished game or a malformed result, and stores none of the batch', async () => {
    store = await openStore(':memory:');
    const unfinished = { ...result('22222222-0000-4000-8000-000000000001'), game: toRecord(replay([0, 1])) };
    expect(await status(() => store.addResults(alice, [result('22222222-0000-4000-8000-000000000002'), unfinished]))).toBe(400);
    expect(await status(() => store.addResults(alice, [{ id: 'short' }]))).toBe(400);
    expect(await status(() => store.addResults(alice, [result('22222222-0000-4000-8000-000000000003', { finishedAt: 1e300 })]))).toBe(400);
    expect((await store.myGames(alice)).total.played).toBe(0);
  });
});

describe('my games', () => {
  it('counts online games and uploaded results for the player across linked devices', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    await store.newGame(code, bob);
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.addResults(alicePhone, [
      result('33333333-0000-4000-8000-000000000001'),
      result('33333333-0000-4000-8000-000000000002', { you: 'O', difficulty: 'easy' }),
      result('33333333-0000-4000-8000-000000000003', { mode: 'friend', you: null, difficulty: null }),
    ]);
    const mine = await store.myGames(alice);
    expect(mine.user?.login).toBe('alice');
    expect(mine.byMode.online).toEqual({ played: 1, won: 1, lost: 0, drawn: 0 });
    expect(mine.byMode.computer).toEqual({ played: 2, won: 1, lost: 1, drawn: 0 });
    expect(mine.byMode.friend).toEqual({ played: 1, won: 0, lost: 0, drawn: 0 });
    expect(mine.byDifficulty.easy.lost).toBe(1);
    expect(mine.total.played).toBe(4);
    expect(mine.sessions).toMatchObject([{ code, you: 'X', games: 1, yourTurn: true }]);
    expect((await store.myGames(carol)).total.played).toBe(0);
  });
});

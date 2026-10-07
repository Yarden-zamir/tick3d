import { mkdtemp } from 'node:fs/promises';
import { toEpochMs as ms } from '../src/epoch.ts';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each test opens its own DuckDB database. On a busy machine (the deploy server runs several
// builds at once) that alone can take seconds, so the 5 s default timed out now and then.
// Revisit if a single store test takes over 20 s: that points at a slow query, not at load.
vi.setConfig({ testTimeout: 20_000 });
import { replay } from '../src/game.ts';
import { nameOf } from '../src/names.ts';
import { type Code, type DeviceGameId, type GameId, type Metrics, type PlayerToken, type ResultUpload, type StatsFilter, ALL_STATS, parseDeviceGameId, parseGameId, toRecord } from '../src/protocol.ts';
import type { PracticeRun } from '../src/practice/practice.ts';
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
  const game = toRecord(replay(X_WINS, { times: X_WINS.map((_, i) => ms(1_000 + i)) }));
  const options = { hideBoard: false, hideHistory: false, hideCoordinates: false };
  return { id, mode: 'computer', game, you: 'X', difficulty: 'hard', finishedAt: ms(2_000), publicId: null, options, tuned: false, metrics: null, guest: null, ...overrides };
}

describe('pruning empty sessions', () => {
  it('deletes old sessions without a move, and keeps played, fresh and watched ones', async () => {
    const hour = 3_600_000;
    let later = 0;
    let watched: Code | undefined;
    store = await openStore(':memory:', {
      // The clock runs `later` ahead, so rows written now count as old.
      now: () => ms(Date.now() + later),
      open: (code) => (code === watched ? [alice] : []),
    });
    const empty = (await store.create(alice, 'Never played')).code;
    const played = (await store.create(alice, 'Played')).code;
    await store.move(played, alice, { game: 0, moveCount: 0, cell: 5 });
    watched = (await store.create(alice, 'Open on a page')).code;

    expect(await store.pruneEmpty(9 * hour)).toEqual([]);
    later = 10 * hour;
    expect(await store.pruneEmpty(9 * hour)).toEqual([empty]);
    expect(await status(() => store.get(empty, alice))).toBe(404);
    expect((await store.get(played, alice)).code).toBe(played);
    expect((await store.get(watched, alice)).code).toBe(watched);
  });
});

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

  it('reports every write, also a timeout that a read records', async () => {
    let time = 1_000_000;
    const changed: Code[] = [];
    store = await openStore(':memory:', { now: () => ms(time), onChange: (code) => changed.push(code) });
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
    store = await openStore(':memory:', { open: () => [alice] });
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

  it('keeps a seat that a logged-in phone takes with the account, so a logout drops it from the phone only', async () => {
    store = await openStore(':memory:');
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    const { code } = await store.create(alicePhone, 'From the phone');
    await store.join(code, bob);
    // Both devices of the account control the seat.
    expect((await store.get(code, alice)).you).toBe('X');
    await store.move(code, alicePhone, { game: 0, moveCount: 0, cell: 0 });
    await store.move(code, bob, { game: 0, moveCount: 1, cell: 1 });
    await store.move(code, alice, { game: 0, moveCount: 2, cell: 16 });
    await store.unlinkToken(alicePhone);
    const phone = await store.get(code, alicePhone);
    expect(phone.you).toBeNull();
    expect(phone.players.X?.login).toBe('alice');
    expect(await status(() => store.move(code, alicePhone, { game: 0, moveCount: 4, cell: 32 }))).toBe(403);
    await store.move(code, bob, { game: 0, moveCount: 3, cell: 2 });
    await store.move(code, alice, { game: 0, moveCount: 4, cell: 32 });
    await store.move(code, bob, { game: 0, moveCount: 5, cell: 3 });
    await store.move(code, alice, { game: 0, moveCount: 6, cell: 48 });
    // The finished game is in the history of the account, and not of the logged-out phone.
    expect((await store.history(alice, 0)).games).toMatchObject([{ id: `${code}-1`, result: 'won' }]);
    expect((await store.history(alicePhone, 0)).games).toEqual([]);
    expect((await store.history(bob, 0)).games).toMatchObject([{ opponent: { login: 'alice' } }]);
    expect((await store.myGames(alice)).sessions).toMatchObject([{ code, you: 'X' }]);
  });

  it('moves a seat that holds the device token to the account on logout', async () => {
    // A session from before account seats: the seat names the phone's own token.
    store = await openStore(':memory:');
    const { code } = await store.create(alicePhone, 'Old session');
    await store.join(code, bob);
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.unlinkToken(alicePhone);
    expect((await store.get(code, alicePhone)).you).toBeNull();
    expect((await store.get(code, alice)).you).toBe('X');
    expect((await store.get(code, bob)).players.X?.login).toBe('alice');
    await store.move(code, alice, { game: 0, moveCount: 0, cell: 5 });
  });

  it('adds the account row for an account that linked before account seats, at a join and at a logout', async () => {
    const path = `${await mkdtemp('/tmp/tick3d-store-')}/linked.duckdb`;
    store = await openStore(path);
    const { code } = await store.create(alicePhone, 'Old seat');
    const other = (await store.create(bob, 'Join later')).code;
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    store.close();
    // A database from before account seats has no account row.
    const instance = await DuckDBInstance.create(path);
    const db = await instance.connect();
    await db.run("DELETE FROM player_tokens WHERE token LIKE 'account-%'");
    db.closeSync();
    instance.closeSync();
    store = await openStore(path);
    // A join of a logged-in laptop takes the seat for the account, and the name resolves.
    await store.join(other, alice);
    expect((await store.get(other, bob)).players.O?.login).toBe('alice');
    expect((await store.get(other, alicePhone)).you).toBe('O');
    // A logout moves the phone's seat to the account, and the name resolves.
    await store.unlinkToken(alicePhone);
    expect((await store.get(code, bob)).players.X?.login).toBe('alice');
    expect((await store.get(code, alice)).you).toBe('X');
    expect((await store.get(code, alicePhone)).you).toBeNull();
  });

  it('moves the finished games of a logged-out device to the account, also games from before the login', async () => {
    store = await openStore(':memory:');
    await store.addResults(alicePhone, [result('44444444-0000-4000-8000-000000000001', { you: 'O' })]);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.addResults(alicePhone, [result('44444444-0000-4000-8000-000000000002', { mode: 'friend', you: null, difficulty: null })]);
    await store.unlinkToken(alicePhone);
    const phone = await store.myGames(alicePhone);
    expect(phone.total.played).toBe(0);
    expect((await store.history(alicePhone, 0)).games).toEqual([]);
    expect(await store.records(alicePhone)).toEqual({});
    // A device that links to the account later sees them.
    await store.linkToken(alice, ALICE_GITHUB);
    expect((await store.myGames(alice)).total.played).toBe(2);
    expect((await store.history(alice, 0)).games.map((entry) => entry.result).sort()).toEqual(['lost', 'played']);
    expect(await store.records(alice)).not.toEqual({});
  });

  it('keeps one Nearby game in the history of the account after the guest logs out', async () => {
    store = await openStore(':memory:');
    const bobLaptop = 'eeeeeeee-0000-4000-8000-000000000005' as PlayerToken;
    const BOB_GITHUB = { id: 202, login: 'bob', avatar: 'https://avatars.githubusercontent.com/u/202?v=4' };
    await store.linkToken(bob, BOB_GITHUB);
    const nearby = { mode: 'nearby', difficulty: null, game: finishedGame(X_WINS) } as const;
    const id = deviceGameId('NEARBY45');
    // The host (Alice, X) names the guest device (Bob, O). Both devices send a result.
    await store.addResults(alice, [
      result('eeeeeeee-1111-4000-8000-000000000001', { ...nearby, you: 'X', publicId: id, guest: bob, metrics: { ...METRICS, nearby: { role: 'host', other: 'phone' } } }),
    ]);
    await store.addResults(bob, [
      result('eeeeeeee-1111-4000-8000-000000000002', { ...nearby, you: 'O', finishedAt: ms(2_034), metrics: { ...METRICS, nearby: { role: 'guest', other: 'computer' } } }),
    ]);
    await store.unlinkToken(bob);
    expect((await store.history(bob, 0)).games).toEqual([]);
    expect((await store.myGames(bob)).total.played).toBe(0);
    await store.linkToken(bobLaptop, BOB_GITHUB);
    expect((await store.history(bobLaptop, 0)).games).toMatchObject([{ id, mode: 'nearby', result: 'lost', opponentName: nameOf(alice) }]);
    expect((await store.history(alice, 0)).games).toMatchObject([{ id, result: 'won', opponent: { login: 'bob' } }]);
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
    expect((await store.addResults(alice, [first])).stored).toBe(1);
    expect((await store.addResults(alice, [first, result('11111111-0000-4000-8000-000000000002')])).stored).toBe(1);
    expect((await store.myGames(alice)).byMode.computer.played).toBe(2);
  });

  it('refuses an unfinished game or a malformed result, and stores none of the batch', async () => {
    store = await openStore(':memory:');
    const unfinished = { ...result('22222222-0000-4000-8000-000000000001'), game: toRecord(replay([0, 1])) };
    expect(await status(() => store.addResults(alice, [result('22222222-0000-4000-8000-000000000002'), unfinished]))).toBe(400);
    expect(await status(() => store.addResults(alice, [{ id: 'short' }]))).toBe(400);
    expect(await status(() => store.addResults(alice, [{ ...result('22222222-0000-4000-8000-000000000003'), finishedAt: 1e300 }]))).toBe(400);
    // DuckDB make_timestamptz throws on a fraction of a millisecond, so the parser must refuse it first.
    expect(await status(() => store.addResults(alice, [{ ...result('22222222-0000-4000-8000-000000000004'), finishedAt: 1.5 }]))).toBe(400);
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
    // The new game swapped the seats: Alice plays O now, and Bob moves first. Her win as X still counts.
    expect(mine.sessions).toMatchObject([{ code, you: 'O', games: 1, yourTurn: false }]);
    expect((await store.myGames(carol)).total.played).toBe(0);
  });
});

// X wins on move 9 along 0, 16, 32, 48.
const X_WINS_LATE = [5, 63, 0, 10, 16, 37, 32, 23, 48];
const METRICS: Metrics = {
  device: 'phone',
  view: 'tower',
  layout: 'grid',
  theme: 'dark',
  input: { board: 3, keypad: 1 },
  refused: { occupied: 2 },
  undos: 1,
  thinkMs: [120, 300],
  offline: false,
  version: 'index-abc123',
  tuning: null,
  nearby: null,
};

function finishedGame(cells: number[]) {
  return toRecord(replay(cells, { times: cells.map((_, i) => ms(1_000 + i * 1_500)) }));
}

const gameId = (text: string): GameId => {
  const id = parseGameId(text);
  if (id === undefined) throw new Error(`bad test id ${text}`);
  return id;
};
const deviceGameId = (text: string): DeviceGameId => {
  const id = parseDeviceGameId(text);
  if (id === undefined) throw new Error(`bad test id ${text}`);
  return id;
};

describe('game links', () => {
  it('opens an uploaded game by its public id, with no token or result id in the answer', async () => {
    store = await openStore(':memory:');
    const id = deviceGameId('ABCDEFGH');
    const upload = result('44444444-0000-4000-8000-000000000001', { publicId: id, metrics: METRICS });
    expect(await store.addResults(alice, [upload])).toEqual({ stored: 1, renamed: {} });
    await store.linkToken(alice, ALICE_GITHUB);
    const shown = await store.game(id);
    expect(shown).toMatchObject({
      id,
      mode: 'computer',
      difficulty: 'hard',
      computer: 'O',
      players: { X: { login: 'alice' }, O: null },
      names: { X: nameOf(alice), O: null },
    });
    expect(shown.game.moves).toEqual(X_WINS);
    const text = JSON.stringify(shown);
    expect(text).not.toContain(alice);
    expect(text).not.toContain(upload.id);
  });

  it('reads a result stored before hide coordinates as not hidden', async () => {
    store = await openStore(':memory:');
    const id = deviceGameId('BCDFGHJK');
    // An older device sent options without hideCoordinates, and the row keeps them as they came.
    const old = { ...result('44444444-0000-4000-8000-000000000002', { publicId: id }), options: { hideBoard: true, hideHistory: false } };
    await store.addResults(alice, [old]);
    expect((await store.game(id)).options).toEqual({ hideBoard: true, hideHistory: false, hideCoordinates: false });
  });

  it('gives a result without an id, or with an id that another game holds, a new unique id', async () => {
    store = await openStore(':memory:');
    const taken = deviceGameId('TAKEN234');
    await store.addResults(alice, [result('55555555-0000-4000-8000-000000000001', { publicId: taken })]);
    const { renamed } = await store.addResults(bob, [
      result('55555555-0000-4000-8000-000000000002', { publicId: taken }),
      result('55555555-0000-4000-8000-000000000003'),
    ]);
    const second = renamed['55555555-0000-4000-8000-000000000002'];
    const third = renamed['55555555-0000-4000-8000-000000000003'];
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(new Set([taken, second, third]).size).toBe(3);
    if (second === undefined) throw new Error('unreachable');
    expect((await store.game(second)).players).toEqual({ X: null, O: null });
    // A device that sends the result again learns the server's id once more.
    expect(await store.addResults(bob, [result('55555555-0000-4000-8000-000000000002', { publicId: taken })])).toEqual({
      stored: 0,
      renamed: { '55555555-0000-4000-8000-000000000002': second },
    });
  });

  it('records each finished online game once, under <CODE>-<n>, without counting it twice in My games', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    await store.newGame(code, bob);
    await store.get(code, bob);
    const shown = await store.game(gameId(`${code}-1`));
    expect(shown).toMatchObject({ mode: 'online', computer: null, difficulty: null, names: { X: nameOf(alice), O: nameOf(bob) } });
    expect(shown.game.moves).toEqual(X_WINS);
    expect(JSON.stringify(shown)).not.toContain(alice);
    expect(await status(() => store.game(gameId(`${code}-2`)))).toBe(404);
    const mine = await store.myGames(alice);
    expect(mine.total).toEqual({ played: 1, won: 1, lost: 0, drawn: 0 });
    expect(mine.sessions).toMatchObject([{ code, opponent: null, opponentName: nameOf(bob) }]);
    expect(JSON.stringify(mine)).not.toContain(bob);
  });

  it('records an online game that ends on time', async () => {
    let time = 1_000_000;
    store = await openStore(':memory:', { now: () => ms(time) });
    const { code } = await store.create(alice, 'Blitz', { perMove: 3, perGame: null });
    await store.join(code, bob);
    await playMoves(code, [0, 1]);
    time += 10_000;
    await store.get(code, alice);
    expect((await store.game(gameId(`${code}-1`))).game.timedOut).toBe(true);
  });

  it('returns 404 for an unknown game', async () => {
    store = await openStore(':memory:');
    expect(await status(() => store.game(gameId('ZZZZZZZZ')))).toBe(404);
  });
});

describe('match history', () => {
  it('lists the games of every mode for the player, newest first, with the result for that player', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    await store.addResults(alice, [
      result('66666666-0000-4000-8000-000000000001', { you: 'O' }),
      result('66666666-0000-4000-8000-000000000002', { mode: 'friend', you: null, difficulty: null, finishedAt: ms(3_000) }),
    ]);
    await store.linkToken(bob, { id: 202, login: 'bob', avatar: 'https://avatars.githubusercontent.com/u/202?v=4' });
    const mine = await store.history(alice, 0);
    expect(mine.more).toBe(false);
    expect(mine.games.map((entry) => [entry.mode, entry.result])).toEqual([
      ['online', 'won'],
      ['friend', 'played'],
      ['computer', 'lost'],
    ]);
    expect(mine.games[0]).toMatchObject({ id: `${code}-1`, moves: 7, opponent: { login: 'bob' }, opponentName: nameOf(bob) });
    // The computer and the friend game have no other player with a name.
    expect(mine.games.slice(1).map((entry) => entry.opponentName)).toEqual([null, null]);
    const theirs = await store.history(bob, 0);
    expect(theirs.games).toMatchObject([{ mode: 'online', result: 'lost', opponent: null, opponentName: nameOf(alice) }]);
    expect(JSON.stringify(mine)).not.toContain(alice);
    expect(JSON.stringify(mine)).not.toContain(bob);
    expect(JSON.stringify(theirs)).not.toContain(alice);
    expect((await store.history(carol, 0)).games).toEqual([]);
  });

  it('gives the guest of a Nearby game the result of the host, with the host as opponent, and returns no token', async () => {
    store = await openStore(':memory:');
    const nearby = { mode: 'nearby', difficulty: null, game: finishedGame(X_WINS) } as const;
    const id = deviceGameId('NEARBY23');
    // Both devices send a result. The host (Alice, X) names the guest (Bob, O).
    await store.addResults(alice, [
      result('dddddddd-1111-4000-8000-000000000001', { ...nearby, you: 'X', publicId: id, guest: bob, metrics: { ...METRICS, nearby: { role: 'host', other: 'phone' } } }),
    ]);
    await store.addResults(bob, [
      // The guest's copy can have a slightly later time for the last move.
      result('dddddddd-1111-4000-8000-000000000002', { ...nearby, you: 'O', finishedAt: ms(2_034), metrics: { ...METRICS, nearby: { role: 'guest', other: 'computer' } } }),
    ]);
    const theirs = await store.history(bob, 0);
    expect(theirs.games).toMatchObject([{ id, mode: 'nearby', result: 'lost', opponentName: nameOf(alice) }]);
    expect((await store.history(alice, 0)).games).toMatchObject([{ id, result: 'won', opponentName: nameOf(bob) }]);
    const shown = await store.game(id);
    expect(shown.names).toEqual({ X: nameOf(alice), O: nameOf(bob) });
    for (const answer of [theirs, shown]) {
      expect(JSON.stringify(answer)).not.toContain(alice);
      expect(JSON.stringify(answer)).not.toContain(bob);
    }
    // A host cannot name itself as the guest.
    const self = result('dddddddd-1111-4000-8000-000000000003', { ...nearby, you: 'X', guest: alice });
    expect(await status(() => store.addResults(alice, [self]))).toBe(400);
  });

  it('pages through the history', async () => {
    store = await openStore(':memory:');
    const uploads = Array.from({ length: 51 }, (_, i) =>
      result(`77777777-0000-4000-8000-${String(i).padStart(12, '0')}`, { finishedAt: ms(10_000 + i) }),
    );
    await store.addResults(alice, uploads);
    const first = await store.history(alice, 0);
    expect(first.games).toHaveLength(50);
    expect(first.more).toBe(true);
    const second = await store.history(alice, 50);
    expect(second).toMatchObject({ more: false, games: [{ finishedAt: 10_000 }] });
  });
});

describe('survival records on the server', () => {
  it('keeps the longest game that the computer won, per setup, on every linked device', async () => {
    store = await openStore(':memory:');
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.addResults(alice, [
      result('88888888-0000-4000-8000-000000000001', { you: 'O' }),
      result('88888888-0000-4000-8000-000000000002', { you: 'X' }),
      result('88888888-0000-4000-8000-000000000003', { you: 'O', tuned: true, game: finishedGame(X_WINS_LATE) }),
    ]);
    await store.addResults(alicePhone, [result('88888888-0000-4000-8000-000000000004', { you: 'O', game: finishedGame(X_WINS_LATE) })]);
    expect(await store.records(alice)).toEqual({
      'hard|game:none|move:none|board:false|history:false': 9,
      'hard|game:none|move:none|board:false|history:false|tuned': 9,
    });
    expect(await store.records(carol)).toEqual({});
  });
});

// A store file with rows as an older version left them: a result without the new columns, and an
// online game that ended before the server recorded games in `results`.
async function oldStore(): Promise<{ path: string; code: Code }> {
  const path = `${await mkdtemp('/tmp/tick3d-store-')}/old.duckdb`;
  store = await openStore(path);
  const { code } = await store.create(alice, 'Old match');
  await store.join(code, bob);
  await playMoves(code, X_WINS);
  store.close();
  const instance = await DuckDBInstance.create(path);
  const db = await instance.connect();
  await db.run("DELETE FROM results WHERE id LIKE 'online:%'");
  const old = { id: '99999999-0000-4000-8000-000000000001', mode: 'computer', game: finishedGame(X_WINS_LATE), you: 'O', difficulty: 'easy', finishedAt: 5_000 };
  await db.run('INSERT INTO results (id, token, doc, finished_at) VALUES ($id, $token, $doc::JSON::VARIANT, make_timestamptz(5000000))', {
    id: old.id,
    token: alice,
    doc: JSON.stringify(old),
  });
  db.closeSync();
  instance.closeSync();
  store = await openStore(path);
  return { path, code };
}

describe('rows from before game links', () => {
  it('reads an old result in the history (without a link), the records and the stats, and changes no row', async () => {
    await oldStore();
    expect((await store.history(alice, 0)).games).toEqual([
      { id: null, mode: 'computer', difficulty: 'easy', result: 'lost', moves: 9, opponent: null, opponentName: null, finishedAt: 5_000 },
    ]);
    expect(await store.records(alice)).toEqual({ 'easy|game:none|move:none|board:false|history:false': 9 });
    const stats = await store.stats();
    expect(stats.levels).toEqual([expect.objectContaining({ level: 'easy', games: 1, lost: 1 })]);
    expect((await store.stats({ ...ALL_STATS, scope: 'mine' }, alice)).personal?.survival).toEqual([{ level: 'easy', moves: 9 }]);
    expect(stats.endings).toEqual([{ key: 'won', count: 1 }]);
    // The old row stays as it was: the one-off migration fills it, not the server.
    expect((await store.history(alice, 0)).games[0]?.id).toBeNull();
  });

  it('opens an online game that is missing from results from its session', async () => {
    const { code } = await oldStore();
    const shown = await store.game(gameId(`${code}-1`));
    expect(shown).toMatchObject({ mode: 'online', computer: null });
    expect(shown.game.moves).toEqual(X_WINS);
    expect(await status(() => store.game(gameId(`${code}-2`)))).toBe(404);
    expect(await status(() => store.game(gameId('ZZZZ-1')))).toBe(404);
  });

  it('clears an old result from the history too', async () => {
    await oldStore();
    expect(await store.clearHistory(alice)).toBe(1);
    expect((await store.history(alice, 0)).games).toEqual([]);
  });
});

describe('clear history', () => {
  it('hides the games of the player on every linked device, and keeps them for the opponent, the stats and the records', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.addResults(alicePhone, [
      result('cccccccc-1111-4000-8000-000000000001', { you: 'O' }),
      result('cccccccc-1111-4000-8000-000000000002', { mode: 'friend', you: null, difficulty: null }),
    ]);
    const records = await store.records(alice);
    expect((await store.history(alice, 0)).games).toHaveLength(3);
    expect(await store.clearHistory(alice)).toBe(4);
    expect((await store.history(alicePhone, 0)).games).toEqual([]);
    expect((await store.history(bob, 0)).games).toMatchObject([{ id: `${code}-1`, result: 'lost' }]);
    expect(await store.records(alice)).toEqual(records);
    expect((await store.stats()).totals.games).toBe(3);
    expect(await store.clearHistory(alice)).toBe(0);
    // A game after the clear shows again.
    await store.addResults(alice, [result('cccccccc-1111-4000-8000-000000000003')]);
    expect((await store.history(alice, 0)).games).toHaveLength(1);
  });
});

describe('online game metrics', () => {
  it('keeps one report per seat, only from the players of a finished game, and counts them in the stats', async () => {
    const code = await session();
    const id = gameId(`${code}-1`);
    expect(await status(() => store.addSeatMetrics(id, alice, METRICS))).toBe(404);
    await playMoves(code, X_WINS);
    expect(await store.addSeatMetrics(id, alice, METRICS)).toBe(true);
    expect(await store.addSeatMetrics(id, alice, { ...METRICS, theme: 'mono' })).toBe(false);
    expect(await store.addSeatMetrics(id, bob, { ...METRICS, device: 'computer', theme: 'mono' })).toBe(true);
    expect(await status(() => store.addSeatMetrics(id, carol, METRICS))).toBe(403);
    expect(await status(() => store.addSeatMetrics(gameId('ABCDEFGH'), alice, METRICS))).toBe(400);
    const stats = await store.stats();
    expect(stats.metricsGames).toBe(2);
    expect(stats.themes).toEqual(expect.arrayContaining([{ key: 'dark', count: 1 }, { key: 'mono', count: 1 }]));
    expect(stats.input).toEqual({ board: 6, keypad: 2 });
  });
});

describe('stats', () => {
  it('counts games, levels, moves and metrics, with no names, no page faults and no tokens', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    await store.linkToken(bob, { id: 202, login: 'bob', avatar: 'https://avatars.githubusercontent.com/u/202?v=4' });
    await store.addResults(bob, [
      result('aaaaaaaa-1111-4000-8000-000000000001', { you: 'O', metrics: METRICS, game: finishedGame(X_WINS_LATE) }),
      result('aaaaaaaa-1111-4000-8000-000000000002', { you: 'X', metrics: { ...METRICS, device: 'computer', theme: 'light' } }),
    ]);
    await store.addResults(carol, [result('aaaaaaaa-1111-4000-8000-000000000003', { you: 'O', options: { hideBoard: true, hideHistory: false, hideCoordinates: true } })]);
    await store.addEvent({ kind: 'error', message: 'TypeError: x is undefined (index.js:1)', version: 'index-abc123' });
    await store.addEvent({ kind: 'error', message: 'TypeError: x is undefined (index.js:1)', version: 'index-abc123' });
    const stats = await store.stats();
    expect(stats.totals).toMatchObject({ games: 4, players: 3, accounts: 1, sessions: 1, moves: 7 + 9 + 7 + 7 });
    expect(stats.byMode).toEqual(expect.arrayContaining([{ key: 'online', count: 1 }, { key: 'computer', count: 3 }]));
    expect(stats.levels).toEqual([expect.objectContaining({ level: 'hard', games: 3, won: 1, lost: 2, drawn: 0 })]);
    expect(stats.openings[0]).toBe(3);
    expect(stats.openings[5]).toBe(1);
    expect(stats.endings).toEqual([{ key: 'axis', count: 4 }]);
    expect(stats.metricsGames).toBe(2);
    expect(stats.themes).toEqual(expect.arrayContaining([{ key: 'dark', count: 1 }, { key: 'light', count: 1 }]));
    expect(stats.refusals).toEqual([{ key: 'occupied', count: 4 }]);
    expect(stats.input).toEqual({ board: 6, keypad: 2 });
    expect(stats.hide).toEqual(expect.arrayContaining([expect.objectContaining({ setting: 'board', coordinates: true, games: 1, computerGames: 1, humanWins: 0 })]));
    expect(stats.moveTimes.reduce((sum, bucket) => sum + bucket.human + bucket.computer, 0)).toBeGreaterThan(0);
    // The page is public: no person and no page fault shows in the Everyone answer.
    const text = JSON.stringify(stats);
    for (const secret of [alice, bob, carol, 'bob', nameOf(carol), 'TypeError']) expect(text).not.toContain(secret);
  });

  it('keeps the answer for a minute', async () => {
    let time = 1_000_000;
    store = await openStore(':memory:', { now: () => ms(time) });
    const first = await store.stats();
    await store.addResults(alice, [result('bbbbbbbb-1111-4000-8000-000000000001')]);
    expect((await store.stats()).totals.games).toBe(first.totals.games);
    time += 60_000;
    expect((await store.stats()).totals.games).toBe(first.totals.games + 1);
  });
});

describe('stats filters', () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const DAY = 86_400_000;
  const all = { scope: 'everyone', range: 'all', mode: null, level: null } as const;

  // Alice: an online win against Bob now, a computer win (hard) a day ago, a computer loss (easy)
  // 10 days ago, and a friend game a day ago. Bob: a computer loss (hard) 40 days ago.
  // Every game is X_WINS, 7 moves that X wins.
  async function seeded(): Promise<void> {
    store = await openStore(':memory:', { now: () => ms(NOW) });
    const { code } = await store.create(alice, 'Friday match');
    await store.join(code, bob);
    await playMoves(code, X_WINS);
    await store.addResults(alice, [
      result('ffffffff-1111-4000-8000-000000000001', { finishedAt: ms(NOW - DAY), metrics: METRICS }),
      result('ffffffff-1111-4000-8000-000000000002', { you: 'O', difficulty: 'easy', finishedAt: ms(NOW - 10 * DAY) }),
      result('ffffffff-1111-4000-8000-000000000003', { mode: 'friend', you: null, difficulty: null, finishedAt: ms(NOW - DAY) }),
    ]);
    await store.addResults(bob, [result('ffffffff-1111-4000-8000-000000000004', { you: 'O', finishedAt: ms(NOW - 40 * DAY) })]);
    await store.addEvent({ kind: 'error', message: 'TypeError: x is undefined (index.js:1)', version: 'index-abc123' });
  }

  const games = async (filter: Partial<StatsFilter>) => (await store.stats({ ...all, ...filter })).totals.games;

  it('filters every game by time', async () => {
    await seeded();
    const everything = await store.stats(all);
    expect(everything.totals.games).toBe(5);
    expect(await games({ range: '30d' })).toBe(4);
    expect(await games({ range: '7d' })).toBe(3);
  });

  it('filters every game by mode and level', async () => {
    await seeded();
    const computer = await store.stats({ ...all, mode: 'computer' });
    expect(computer.totals.games).toBe(3);
    expect(computer.byMode).toEqual([{ key: 'computer', count: 3 }]);
    expect(computer.lengths[X_WINS.length]).toBe(3);
    expect(computer.openings[0]).toBe(3);
    expect(computer.openingWinsX[0]).toBe(3);
    expect(await games({ mode: 'computer', level: 'hard' })).toBe(2);
    expect(await games({ level: 'easy' })).toBe(1);
  });

  it('shows the win rate against the computer over time, from the player side', async () => {
    await seeded();
    // Oldest first: Bob lost, Alice lost on easy, Alice won on hard.
    expect((await store.stats(all)).form.map((point) => point.rate)).toEqual([0, 0, 1 / 3]);
    expect((await store.stats(all)).personal).toBeNull();
  });

  it('counts only the games of the player for Mine, on all linked devices, with streaks and opponents', async () => {
    await seeded();
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    const mine = await store.stats({ ...all, scope: 'mine' }, alicePhone);
    expect(mine.totals.games).toBe(4);
    expect(mine.filter.scope).toBe('mine');
    // Oldest first: lost on easy, won on hard, won online. The friend game has no side.
    expect(mine.form.map((point) => point.rate)).toEqual([0, 1 / 2, 2 / 3]);
    expect(mine.personal).toEqual({
      // The computer won the easy game after 7 moves.
      survival: [{ level: 'easy', moves: X_WINS.length }],
      results: expect.arrayContaining([
        { mode: 'computer', level: 'easy', won: 0, drawn: 0, lost: 1 },
        { mode: 'computer', level: 'hard', won: 1, drawn: 0, lost: 0 },
        { mode: 'online', level: null, won: 1, drawn: 0, lost: 0 },
      ]),
      bestStreak: 2,
      currentStreak: { outcome: 'won', length: 2 },
      opponents: [{ player: nameOf(bob), games: 1, won: 1, drawn: 0, lost: 0 }],
    });
    expect(mine.personal?.results).toHaveLength(3);
    // Only the reports of Alice's own devices.
    expect(mine.metricsGames).toBe(1);
    const text = JSON.stringify(mine);
    for (const token of [alice, alicePhone, bob]) expect(text).not.toContain(token);
  });

  it('applies the other filters to Mine too, and names the opponent by the GitHub login', async () => {
    await seeded();
    await store.linkToken(alice, ALICE_GITHUB);
    const bobs = await store.stats({ ...all, scope: 'mine', range: '30d' }, bob);
    // Bob's computer loss is 40 days old.
    expect(bobs.totals.games).toBe(1);
    expect(bobs.personal).toMatchObject({ bestStreak: 0, currentStreak: { outcome: 'lost', length: 1 }, opponents: [{ player: 'alice', games: 1, lost: 1 }] });
    expect(JSON.stringify(bobs)).not.toContain(bob);
  });

  it('refuses Mine without a player', async () => {
    store = await openStore(':memory:');
    expect(await status(() => store.stats({ ...all, scope: 'mine' }))).toBe(400);
  });
});

describe('sound practice', () => {
  const run = (id: string, totalMs: number, mode: 'targets' | 'echo' = 'targets', score = 10): PracticeRun => {
    const rounds = mode === 'targets' ? 10 : 8;
    const roundMs = Array.from({ length: rounds }, (_, i) => Math.floor(totalMs / rounds) + (i === 0 ? totalMs % rounds : 0));
    return { id, mode, preset: 'normal', roundMs, score };
  };

  it('stores a run once, ranks each person by their best run, and names them', async () => {
    store = await openStore(':memory:');
    await store.linkToken(alice, ALICE_GITHUB);
    expect(await store.addPracticeRun(alice, run('run-alice-1', 30_000))).toEqual({ stored: true });
    expect(await store.addPracticeRun(alice, run('run-alice-1', 30_000))).toEqual({ stored: false });
    await store.addPracticeRun(alicePhone, run('run-alice-2', 20_000));
    await store.linkToken(alicePhone, ALICE_GITHUB);
    await store.addPracticeRun(bob, run('run-bob-1', 25_000));
    const board = await store.practiceBoard('targets', 'normal', bob);
    expect(board.top.map(({ player, totalMs }) => [player, totalMs])).toEqual([
      ['alice', 20_000],
      [nameOf(bob), 25_000],
    ]);
    expect(board.you).toEqual({ totalMs: 25_000, score: 10 });
    expect((await store.practiceBoard('targets', 'normal', alice)).you?.totalMs).toBe(20_000);
    expect((await store.practiceBoard('targets', 'normal', undefined)).you).toBeNull();
    expect((await store.practiceBoard('targets', 'easy', undefined)).top).toEqual([]);
    const { practice } = await store.stats();
    expect(practice.runs).toEqual([{ mode: 'targets', preset: 'normal', runs: 3, players: 2, avgRoundMs: 2500 }]);
    expect(practice.best.map((entry) => entry.player)).toEqual(['alice', nameOf(bob)]);
  });

  it('shows a custom name on the practice board and in the practice stats', async () => {
    store = await openStore(':memory:');
    await store.setName(bob, 'Bea');
    await store.addPracticeRun(bob, run('run-bob-named', 25_000));
    expect((await store.practiceBoard('targets', 'normal', undefined)).top.map((entry) => entry.player)).toEqual(['Bea']);
    expect((await store.stats()).practice.best.map((entry) => entry.player)).toEqual(['Bea']);
  });

  it('ranks echo runs by points first, then time', async () => {
    store = await openStore(':memory:');
    await store.addPracticeRun(alice, run('run-echo-a', 40_000, 'echo', 700));
    await store.addPracticeRun(bob, run('run-echo-b', 20_000, 'echo', 600));
    const board = await store.practiceBoard('echo', 'normal', undefined);
    expect(board.top.map(({ score }) => score)).toEqual([700, 600]);
  });

  it('runs a playoff in a session: both join, both hit every target, and the session keeps it', async () => {
    let clock = 1_000;
    store = await openStore(':memory:', { now: () => ms(clock) });
    const { code } = await store.create(alice, 'Playoff');
    expect(await status(() => store.playoff(code, alice, { action: 'start', preset: 'easy', seed: 5 }))).toBe(409);
    await store.join(code, bob);
    expect(await status(() => store.playoff(code, carol, { action: 'start', preset: 'easy', seed: 5 }))).toBe(403);
    const started = await store.playoff(code, alice, { action: 'start', preset: 'easy', seed: 5 });
    expect(started.playoff).toMatchObject({ id: 1, by: 'X', startAt: null });
    const joined = await store.playoff(code, bob, { action: 'join', id: 1 });
    const startAt = joined.playoff?.startAt ?? 0;
    expect(startAt).toBe(clock + 3000);
    clock = startAt + 10;
    for (let index = 0; index < 10; index++) {
      await store.playoff(code, alice, { action: 'hit', id: 1, index, ms: 1000 });
      await store.playoff(code, bob, { action: 'hit', id: 1, index, ms: 1200 });
    }
    const done = await store.get(code, carol);
    expect(done.playoff?.ended).toBe('done');
    expect(done.playoff?.seats.X.times).toHaveLength(10);
  });
});

describe('seat controls', () => {
  it('lists the open tokens without a seat as watchers, by an opaque id, and never shows a token', async () => {
    let open: PlayerToken[] = [];
    store = await openStore(':memory:', { open: () => open });
    const { code } = await store.create(alice, 'Watched');
    await store.join(code, bob);
    open = [alice, carol, carol];
    const view = await store.get(code, bob);
    expect(view.presence).toEqual({ X: true, O: false });
    expect(view.watchers).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: nameOf(carol), player: null }]);
    expect(JSON.stringify(view)).not.toContain(carol);
    expect(JSON.stringify(view)).not.toContain(alice);
    // The id is the same for every reader, so a player can act on it. Only Carol sees it as her own.
    expect((await store.get(code, alice)).watchers).toEqual(view.watchers);
    expect(view.youWatcher).toBeNull();
    expect((await store.get(code, carol)).youWatcher).toBe(view.watchers[0]?.id);
    // Dave watches too: each watcher gets its own id, never the id of another watcher.
    const dave = 'eeeeeeee-0000-4000-8000-000000000005' as PlayerToken;
    open = [alice, carol, dave];
    const both = (await store.get(code, carol)).watchers;
    expect(both).toHaveLength(2);
    expect((await store.get(code, carol)).youWatcher).toBe(both[0]?.id);
    expect((await store.get(code, dave)).youWatcher).toBe(both[1]?.id);
    expect(both[0]?.id).not.toBe(both[1]?.id);
  });

  it('asks before a swap, applies it on accept, and seats a watcher without asking', async () => {
    let open: PlayerToken[] = [];
    store = await openStore(':memory:', { open: () => open });
    const { code } = await store.create(alice, 'Seats');
    await store.join(code, bob);
    open = [alice, bob, carol];
    const asked = await store.seat(code, alice, { action: 'swap' });
    expect(asked.seatRequest).toMatchObject({ kind: 'swap', from: 'X' });
    expect((await store.get(code, bob)).seatRequest).toMatchObject({ kind: 'swap', from: 'X' });
    expect((await store.answerSeat(code, bob, true)).you).toBe('X');
    expect((await store.get(code, alice)).you).toBe('O');
    // Alice (O now) leaves, and Bob seats the watcher in the empty seat.
    await store.seat(code, alice, { action: 'leave' });
    const watcher = (await store.get(code, bob)).watchers.find((entry) => entry.name === nameOf(carol));
    if (watcher === undefined) throw new Error('carol is not a watcher');
    expect((await store.seat(code, bob, { action: 'seat', watcher: watcher.id })).seats).toEqual({ X: true, O: true });
    expect((await store.get(code, carol)).you).toBe('O');
    expect(await status(() => store.seat(code, alice, { action: 'swap' }))).toBe(403);
    // Bob (X) moves and asks to undo. Carol (O) accepts, and the move goes back.
    await store.move(code, bob, { game: 0, moveCount: 0, cell: 21 });
    expect((await store.seat(code, bob, { action: 'undo' })).seatRequest).toMatchObject({ kind: 'undo', from: 'X' });
    expect((await store.answerSeat(code, carol, true)).games[0]?.moves).toEqual([]);
  });
});

describe('seat controls with accounts', () => {
  it('gives a seat to a logged-in watcher as an account seat, so a logout drops it from that device', async () => {
    let open: PlayerToken[] = [];
    store = await openStore(':memory:', { open: () => open });
    const { code } = await store.create(bob, 'Give');
    await store.linkToken(alice, ALICE_GITHUB);
    await store.linkToken(alicePhone, ALICE_GITHUB);
    open = [bob, alicePhone];
    const watching = await store.get(code, alicePhone);
    expect(watching.watchers).toMatchObject([{ player: { login: 'alice' } }]);
    expect(watching.youWatcher).toBe(watching.watchers[0]?.id);
    const id = watching.watchers[0]?.id;
    if (id === undefined) throw new Error('no watcher');
    await store.seat(code, bob, { action: 'seat', watcher: id });
    expect((await store.get(code, alice)).you).toBe('O');
    await store.unlinkToken(alicePhone);
    expect((await store.get(code, alicePhone)).you).toBeNull();
    expect((await store.get(code, alice)).you).toBe('O');
  });
});

describe('seat controls for an account without an account row', () => {
  it('seats a logged-in watcher whose account linked before account seats, and resolves the name', async () => {
    let open: PlayerToken[] = [];
    const path = `${await mkdtemp('/tmp/tick3d-store-')}/watcher.duckdb`;
    store = await openStore(path, { open: () => open });
    const { code } = await store.create(bob, 'Seat an old account');
    await store.linkToken(alicePhone, ALICE_GITHUB);
    store.close();
    const instance = await DuckDBInstance.create(path);
    const db = await instance.connect();
    await db.run("DELETE FROM player_tokens WHERE token LIKE 'account-%'");
    db.closeSync();
    instance.closeSync();
    store = await openStore(path, { open: () => open });
    open = [bob, alicePhone];
    const watching = await store.get(code, alicePhone);
    expect(watching.youWatcher).toBe(watching.watchers[0]?.id);
    const id = watching.watchers[0]?.id;
    if (id === undefined) throw new Error('no watcher');
    await store.seat(code, bob, { action: 'seat', watcher: id });
    expect((await store.get(code, bob)).players.O?.login).toBe('alice');
    expect((await store.get(code, alicePhone)).you).toBe('O');
  });
});

describe('custom names', () => {
  it('shows a custom name in views, history, My games, game links and stats, and goes back on reset', async () => {
    const code = await session();
    await store.setName(alice, 'Dana');
    await playMoves(code, X_WINS);
    expect((await store.get(code, bob)).names).toEqual({ X: 'Dana', O: nameOf(bob) });
    expect((await store.history(bob, 0)).games[0]).toMatchObject({ opponentName: 'Dana' });
    expect((await store.myGames(bob)).sessions[0]).toMatchObject({ opponentName: 'Dana' });
    expect((await store.game(gameId(`${code}-1`))).names.X).toBe('Dana');
    // Bob's own stats name Alice as his opponent.
    expect((await store.stats({ ...ALL_STATS, scope: 'mine' }, bob)).personal?.opponents).toEqual([expect.objectContaining({ player: 'Dana' })]);
    expect(await store.customName(alice)).toBe('Dana');
    await store.clearName(alice);
    expect(await store.customName(alice)).toBeNull();
    expect((await store.get(code, bob)).names.X).toBe(nameOf(alice));
  });

  // A custom name belongs to the device token. A logout moves the games and seats of the device to the
  // account token (unlinkToken), so they show the GitHub login, and the device keeps its own name.
  it('keeps a custom name with the device on logout, so the games that move to the account do not show it', async () => {
    const code = await session();
    await store.setName(alice, 'Dana');
    await playMoves(code, X_WINS);
    await store.linkToken(alice, ALICE_GITHUB);
    await store.unlinkToken(alice);
    const view = await store.get(code, bob);
    expect(view.players.X?.login).toBe('alice');
    expect(view.names.X).not.toBe('Dana');
    expect((await store.history(bob, 0)).games[0]).toMatchObject({ opponent: { login: 'alice' } });
    expect((await store.history(bob, 0)).games[0]?.opponentName).not.toBe('Dana');
    expect((await store.game(gameId(`${code}-1`))).names.X).not.toBe('Dana');
    expect(await store.customName(alice)).toBe('Dana');
  });

  it('refuses a name that equals a GitHub login, in any case', async () => {
    store = await openStore(':memory:');
    await store.linkToken(carol, ALICE_GITHUB);
    expect(await status(() => store.setName(bob, 'ALICE'))).toBe(409);
    expect(await store.customName(bob)).toBeNull();
  });
});

describe('seat rotation', () => {
  it('records each game with the players that held its seats, so history and my games count each game by its seat', async () => {
    const code = await session();
    await playMoves(code, X_WINS);
    expect((await store.newGame(code, bob)).you).toBe('X');
    // Bob moves first in game 2, and wins it as X.
    for (const [moveCount, cell] of X_WINS.entries()) await store.move(code, moveCount % 2 === 0 ? bob : alice, { game: 1, moveCount, cell });
    expect((await store.game(gameId(`${code}-1`))).names).toEqual({ X: nameOf(alice), O: nameOf(bob) });
    expect((await store.game(gameId(`${code}-2`))).names).toEqual({ X: nameOf(bob), O: nameOf(alice) });
    expect((await store.history(alice, 0)).games.map((entry) => entry.result)).toEqual(['lost', 'won']);
    expect((await store.myGames(alice)).byMode.online).toEqual({ played: 2, won: 1, lost: 1, drawn: 0 });
    expect((await store.myGames(bob)).byMode.online).toEqual({ played: 2, won: 1, lost: 1, drawn: 0 });
  });
});

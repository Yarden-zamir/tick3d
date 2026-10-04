import { afterEach, describe, expect, it } from 'vitest';
import type { TimeControl } from '../src/clock.ts';
import { CODE_ALPHABET, type Code, MAX_SESSIONS, type PlayerToken } from '../src/protocol.ts';
import { type Store, StoreError, openStore } from './store.ts';

const alice = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const bob = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
const carol = 'cccccccc-0000-4000-8000-000000000003' as PlayerToken;

let store: Store;
afterEach(() => store.close());

async function status(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof StoreError) return error.status;
    throw error;
  }
  return undefined;
}

async function playedSession(): Promise<Code> {
  store = await openStore(':memory:');
  const { code } = await store.create(alice, 'Friday match');
  await store.join(code, bob);
  return code;
}

async function playMoves(code: Code, cells: number[], first = 0): Promise<void> {
  for (const [i, cell] of cells.entries()) {
    const moveCount = first + i;
    await store.move(code, moveCount % 2 === 0 ? alice : bob, { game: 0, moveCount, cell });
  }
}

const X_WINS = [0, 1, 16, 2, 32, 3, 48];

describe('sessions', () => {
  it('creates a 4 character code and seats the creator as X', async () => {
    store = await openStore(':memory:');
    const view = await store.create(alice, '  Friday match ');
    expect(view.code).toHaveLength(4);
    expect([...view.code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    expect(view).toMatchObject({
      name: 'Friday match',
      you: 'X',
      games: [{ moves: [], times: [], clock: { perMove: null, perGame: null }, timedOut: false }],
      seats: { X: true, O: false },
      clock: { perMove: null, perGame: null },
    });
  });

  it('seats the second player as O and lets a third one watch', async () => {
    const code = await playedSession();
    expect((await store.get(code, bob)).you).toBe('O');
    expect(await status(() => store.join(code, carol))).toBe(409);
    expect((await store.get(code, carol)).you).toBeNull();
  });

  it('returns 404 for an unknown code', async () => {
    store = await openStore(':memory:');
    expect(await status(() => store.get('ZZZZ' as Code, alice))).toBe(404);
  });

  it('rejects an invalid name', async () => {
    store = await openStore(':memory:');
    expect(await status(() => store.create(alice, '   '))).toBe(400);
    expect(await status(() => store.create(alice, 'x'.repeat(41)))).toBe(400);
  });

  it('lets only seated players rename', async () => {
    const code = await playedSession();
    expect((await store.update(code, bob, { name: 'Rematch' })).name).toBe('Rematch');
    expect(await status(() => store.update(code, carol, { name: 'Mine' }))).toBe(403);
  });

  it('keeps a session after the store reopens the same file', async () => {
    const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/tick3d-store-'));
    const path = `${dir}/sessions.duckdb`;
    store = await openStore(path);
    const { code } = await store.create(alice, 'Persistent');
    await store.join(code, bob);
    await store.move(code, alice, { game: 0, moveCount: 0, cell: 5 });
    store.close();
    store = await openStore(path);
    expect(await store.get(code, bob)).toMatchObject({ name: 'Persistent', you: 'O', games: [{ moves: [5] }] });
  });
});

describe('moves', () => {
  it('enforces seat, turn, stale state and occupied cells', async () => {
    const code = await playedSession();
    expect(await status(() => store.move(code, carol, { game: 0, moveCount: 0, cell: 0 }))).toBe(403);
    expect(await status(() => store.move(code, bob, { game: 0, moveCount: 0, cell: 0 }))).toBe(409);
    await store.move(code, alice, { game: 0, moveCount: 0, cell: 0 });
    expect(await status(() => store.move(code, bob, { game: 0, moveCount: 0, cell: 1 }))).toBe(409);
    expect(await status(() => store.move(code, bob, { game: 0, moveCount: 1, cell: 0 }))).toBe(409);
    expect((await store.move(code, bob, { game: 0, moveCount: 1, cell: 1 })).games[0]?.moves).toEqual([0, 1]);
  });

  it('runs requests that arrive together one after the other', async () => {
    const code = await playedSession();
    // Both claim move 0. Exactly one may land; the other sees a changed board.
    const results = await Promise.allSettled([
      store.move(code, alice, { game: 0, moveCount: 0, cell: 0 }),
      store.move(code, alice, { game: 0, moveCount: 0, cell: 1 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.get(code, alice)).games[0]?.moves).toHaveLength(1);
  });

  it('keeps finished games in the history when a new game starts', async () => {
    const code = await playedSession();
    expect(await status(() => store.newGame(code, alice))).toBe(409);
    await playMoves(code, X_WINS);
    expect(await status(() => store.move(code, bob, { game: 0, moveCount: 7, cell: 5 }))).toBe(409);
    const view = await store.newGame(code, bob);
    expect(view.games.map((game) => game.moves)).toEqual([X_WINS, []]);
    expect((await store.get(code, carol)).games[0]?.moves).toEqual(X_WINS);
  });
});

describe('match options and lock', () => {
  it('shares options with the other player and watchers', async () => {
    const code = await playedSession();
    expect((await store.get(code, alice)).options).toEqual({ hideBoard: false, hideHistory: false });
    await store.update(code, alice, { hideBoard: true });
    expect((await store.get(code, bob)).options).toEqual({ hideBoard: true, hideHistory: false });
    expect((await store.get(code, carol)).options.hideBoard).toBe(true);
    expect(await status(() => store.update(code, carol, { hideHistory: true }))).toBe(403);
  });

  it('locks options for both players until the game ends, but not the name', async () => {
    const code = await playedSession();
    expect(await status(() => store.lock(code, carol))).toBe(403);
    expect((await store.lock(code, bob)).locked).toBe(true);
    expect((await store.get(code, alice)).locked).toBe(true);
    expect((await store.lock(code, alice)).locked).toBe(true);
    expect(await status(() => store.update(code, alice, { hideBoard: true }))).toBe(409);
    expect(await status(() => store.update(code, bob, { hideHistory: true }))).toBe(409);
    expect((await store.update(code, alice, { name: 'Locked match' })).name).toBe('Locked match');

    await playMoves(code, X_WINS);
    expect((await store.get(code, alice)).locked).toBe(false);
    expect(await status(() => store.lock(code, alice))).toBe(409);
    expect((await store.update(code, bob, { hideBoard: true })).options.hideBoard).toBe(true);
    expect((await store.newGame(code, alice)).locked).toBe(false);
  });
});

describe('clock', () => {
  let time = 1_000_000;
  const clockStore = async (clock: TimeControl): Promise<Code> => {
    time = 1_000_000;
    store = await openStore(':memory:', MAX_SESSIONS, () => time);
    const { code } = await store.create(alice, 'Timed', clock);
    await store.join(code, bob);
    return code;
  };
  const move = (code: Code, player: PlayerToken, moveCount: number, cell: number) =>
    store.move(code, player, { game: 0, moveCount, cell });

  it('records a timeout on the next read, without a page reporting it', async () => {
    const code = await clockStore({ perMove: 10, perGame: null });
    await move(code, alice, 0, 0);
    time += 60_000; // first moves are untimed
    await move(code, bob, 1, 1);
    time += 9_000;
    await move(code, alice, 2, 2);
    time += 10_001;
    expect((await store.get(code, carol)).games[0]).toMatchObject({ timedOut: true, moves: [0, 1, 2] });
    expect(await status(() => move(code, bob, 3, 3))).toBe(409);
    expect((await store.newGame(code, bob)).games).toHaveLength(2);
  });

  it('applies both limits together', async () => {
    const code = await clockStore({ perMove: 20, perGame: 30 });
    await move(code, alice, 0, 0);
    await move(code, bob, 1, 1);
    time += 19_000; // inside the move limit
    await move(code, alice, 2, 2);
    await move(code, bob, 3, 3);
    time += 11_001; // inside the move limit, but X has used 30 s of the game limit
    expect((await store.get(code, alice)).games[0]?.timedOut).toBe(true);
  });

  it('keeps the limit of a started game and applies a change from the next game', async () => {
    const code = await clockStore({ perMove: null, perGame: null });
    const before = await store.update(code, alice, { clock: { perMove: 30, perGame: null } });
    expect(before.games[0]?.clock).toEqual({ perMove: 30, perGame: null });
    await move(code, alice, 0, 0);
    const during = await store.update(code, bob, { clock: { perMove: null, perGame: 300 } });
    expect(during.clock).toEqual({ perMove: null, perGame: 300 });
    expect(during.games[0]?.clock).toEqual({ perMove: 30, perGame: null });
    await playMoves(code, X_WINS.slice(1), 1);
    expect((await store.newGame(code, alice)).games[1]?.clock).toEqual({ perMove: null, perGame: 300 });
  });

  it('never stores an out-of-range limit', async () => {
    store = await openStore(':memory:');
    await expect(store.create(alice, 'Bad', { perMove: 1, perGame: null })).rejects.toThrow();
  });
});

describe('retention', () => {
  it('deletes the oldest sessions past the limit', async () => {
    store = await openStore(':memory:', 3);
    const codes: Code[] = [];
    for (let i = 0; i < 5; i++) codes.push((await store.create(alice, `Game ${i}`)).code);
    expect(await status(() => store.get(codes[0]!, alice))).toBe(404);
    expect(await status(() => store.get(codes[1]!, alice))).toBe(404);
    for (const code of codes.slice(2)) expect((await store.get(code, alice)).code).toBe(code);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { CODE_ALPHABET, type Code, type PlayerToken } from '../src/protocol.ts';
import { type Store, StoreError, openStore } from './store.ts';

const alice = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const bob = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
const carol = 'cccccccc-0000-4000-8000-000000000003' as PlayerToken;

let store: Store;
afterEach(() => store.close());

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StoreError) return error.status;
    throw error;
  }
  return undefined;
}

function playedSession() {
  store = openStore(':memory:');
  const { code } = store.create(alice, 'Friday match');
  store.join(code, bob);
  return code;
}

describe('sessions', () => {
  it('creates a 4 character code and seats the creator as X', () => {
    store = openStore(':memory:');
    const view = store.create(alice, '  Friday match ');
    expect(view.code).toHaveLength(4);
    expect([...view.code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    expect(view).toMatchObject({ name: 'Friday match', you: 'X', games: [[]], seats: { X: true, O: false } });
  });

  it('seats the second player as O and lets a third one watch', () => {
    const code = playedSession();
    expect(store.get(code, bob).you).toBe('O');
    expect(status(() => store.join(code, carol))).toBe(409);
    expect(store.get(code, carol).you).toBeNull();
  });

  it('returns 404 for an unknown code', () => {
    store = openStore(':memory:');
    expect(status(() => store.get('ZZZZ' as Code, alice))).toBe(404);
  });

  it('rejects an invalid name', () => {
    store = openStore(':memory:');
    expect(status(() => store.create(alice, '   '))).toBe(400);
    expect(status(() => store.create(alice, 'x'.repeat(41)))).toBe(400);
  });

  it('lets only seated players rename', () => {
    const code = playedSession();
    expect(store.rename(code, bob, 'Rematch').name).toBe('Rematch');
    expect(status(() => store.rename(code, carol, 'Mine'))).toBe(403);
  });
});

describe('moves', () => {
  it('enforces seat, turn, stale state and occupied cells', () => {
    const code = playedSession();
    expect(status(() => store.move(code, carol, { game: 0, moveCount: 0, cell: 0 }))).toBe(403);
    expect(status(() => store.move(code, bob, { game: 0, moveCount: 0, cell: 0 }))).toBe(409);
    store.move(code, alice, { game: 0, moveCount: 0, cell: 0 });
    expect(status(() => store.move(code, bob, { game: 0, moveCount: 0, cell: 1 }))).toBe(409);
    expect(status(() => store.move(code, bob, { game: 0, moveCount: 1, cell: 0 }))).toBe(409);
    expect(store.move(code, bob, { game: 0, moveCount: 1, cell: 1 }).games).toEqual([[0, 1]]);
  });

  it('keeps finished games in the history when a new game starts', () => {
    const code = playedSession();
    expect(status(() => store.newGame(code, alice))).toBe(409);
    const moves = [0, 1, 16, 2, 32, 3, 48];
    moves.forEach((cell, i) => store.move(code, i % 2 === 0 ? alice : bob, { game: 0, moveCount: i, cell }));
    expect(status(() => store.move(code, bob, { game: 0, moveCount: 7, cell: 5 }))).toBe(409);
    const view = store.newGame(code, bob);
    expect(view.games).toEqual([moves, []]);
    expect(store.get(code, carol).games[0]).toEqual(moves);
  });
});

describe('retention', () => {
  it('deletes the oldest sessions past the limit', () => {
    store = openStore(':memory:', 3);
    const codes = Array.from({ length: 5 }, (_, i) => store.create(alice, `Game ${i}`).code);
    expect(status(() => store.get(codes[0]!, alice))).toBe(404);
    expect(status(() => store.get(codes[1]!, alice))).toBe(404);
    for (const code of codes.slice(2)) expect(store.get(code, alice).code).toBe(code);
  });
});

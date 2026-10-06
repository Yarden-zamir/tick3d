import { describe, expect, it } from 'vitest';
import type { TimeControl } from '../clock.ts';
import { nameOf } from '../names.ts';
import type { Code } from '../protocol.ts';
import * as core from './core.ts';
import type { SessionDoc } from './format.ts';

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';
const alice = new Set([ALICE]);
const bob = new Set([BOB]);
const carol = new Set([CAROL]);
const X_WINS = [0, 1, 16, 2, 32, 3, 48];

function onlineDoc(clock?: TimeControl): SessionDoc {
  const doc = core.createDoc({ name: 'Match', mode: 'online', seats: { X: ALICE, O: null }, ...(clock ? { clock } : {}) });
  return core.join(doc, bob, BOB);
}

function play(doc: SessionDoc, cells: number[], { start = 0, at = (i: number) => i } = {}): SessionDoc {
  return cells.reduce((current, cell, i) => {
    const moveCount = start + i;
    const who = moveCount % 2 === 0 ? alice : bob;
    return core.move(current, who, { game: current.games.length - 1, moveCount, cell }, at(moveCount));
  }, doc);
}

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof core.SessionError) return error.status;
    throw error;
  }
  return undefined;
}

const view = (doc: SessionDoc, identity: core.Identity) =>
  core.viewOf(doc, {
    code: 'ABCD' as Code,
    version: 1,
    identity,
    now: 0,
    presence: { X: true, O: false },
    players: { X: null, O: null },
  });

describe('seats', () => {
  it('seats the creator as X, the next player as O, and lets a third one watch', () => {
    const doc = onlineDoc();
    expect(view(doc, alice).you).toBe('X');
    expect(view(doc, bob).you).toBe('O');
    expect(status(() => core.join(doc, carol, CAROL))).toBe(409);
    expect(view(doc, carol).you).toBeNull();
    expect(core.join(doc, bob, BOB)).toBe(doc);
  });

  it('gives a player every seat held by any of their tokens', () => {
    const phone = 'dddddddd-0000-4000-8000-000000000004';
    const doc = onlineDoc();
    // Alice logged in on a phone: the phone token and the laptop token form one identity.
    expect(core.seatsOf(doc, new Set([phone, ALICE]))).toEqual(['X']);
    expect(core.seatsOf(doc, new Set([phone]))).toEqual([]);
  });

  it('lets one device play both seats in a friend game', () => {
    const doc = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    const next = core.move(core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, 0), alice, { game: 0, moveCount: 1, cell: 1 }, 1);
    expect(next.games[0]?.moves).toEqual([0, 1]);
  });

  it('lets the device move for the computer only with the computer token', () => {
    const doc = core.createDoc({
      name: 'Versus',
      mode: 'computer',
      seats: { X: ALICE, O: core.COMPUTER_TOKEN },
      computer: { difficulty: 'hard', seat: 'O' },
    });
    const afterX = core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, 0);
    expect(status(() => core.move(afterX, alice, { game: 0, moveCount: 1, cell: 1 }, 1))).toBe(409);
    const device = new Set([ALICE, core.COMPUTER_TOKEN]);
    expect(core.move(afterX, device, { game: 0, moveCount: 1, cell: 1 }, 1).games[0]?.moves).toEqual([0, 1]);
  });
});

describe('names', () => {
  it('names each player from their token, the same for every viewer, and never shows a token', () => {
    const doc = onlineDoc();
    const names = view(doc, carol).names;
    expect(names).toEqual({ X: nameOf(ALICE), O: nameOf(BOB) });
    expect(view(doc, alice).names).toEqual(names);
    expect(JSON.stringify(view(doc, alice))).not.toContain(ALICE);
  });

  it('gives no name to an empty seat or to the computer', () => {
    const waiting = core.createDoc({ name: 'Match', mode: 'online', seats: { X: ALICE, O: null } });
    expect(view(waiting, alice).names).toEqual({ X: nameOf(ALICE), O: null });
    const versus = core.createDoc({
      name: 'Versus',
      mode: 'computer',
      seats: { X: core.COMPUTER_TOKEN, O: ALICE },
      computer: { difficulty: 'hard', seat: 'X' },
    });
    expect(view(versus, alice).names).toEqual({ X: null, O: nameOf(ALICE) });
  });
});

describe('moves', () => {
  it('enforces seat, turn, stale state and occupied cells', () => {
    const doc = onlineDoc();
    expect(status(() => core.move(doc, carol, { game: 0, moveCount: 0, cell: 0 }, 0))).toBe(403);
    expect(status(() => core.move(doc, bob, { game: 0, moveCount: 0, cell: 0 }, 0))).toBe(409);
    const one = core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, 0);
    expect(status(() => core.move(one, bob, { game: 0, moveCount: 0, cell: 1 }, 1))).toBe(409);
    expect(status(() => core.move(one, bob, { game: 0, moveCount: 1, cell: 0 }, 1))).toBe(409);
    expect(core.move(one, bob, { game: 0, moveCount: 1, cell: 1 }, 1).games[0]?.moves).toEqual([0, 1]);
  });

  it('never changes the document it was given', () => {
    const doc = onlineDoc();
    const before = JSON.stringify(doc);
    play(doc, X_WINS);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('games in a session', () => {
  it('asks players of a shared game to finish it first, but lets one device give up a game', () => {
    const shared = play(onlineDoc(), [0, 1]);
    expect(status(() => core.newGame(shared, alice))).toBe(409);
    const local = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    const given = core.newGame(core.move(local, alice, { game: 0, moveCount: 0, cell: 5 }, 0), alice);
    expect(given.games.map((game) => game.moves)).toEqual([[5], []]);
  });

  it('replaces an empty live game instead of stacking empty games', () => {
    const doc = onlineDoc();
    expect(core.newGame(doc, alice).games).toHaveLength(1);
  });

  it('undoes moves on one device only, and never in a timed game', () => {
    const local = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    const two = core.move(core.move(local, alice, { game: 0, moveCount: 0, cell: 0 }, 0), alice, { game: 0, moveCount: 1, cell: 1 }, 1);
    expect(core.undo(two, alice, 1).games[0]?.moves).toEqual([0]);
    expect(status(() => core.undo(play(onlineDoc(), [0, 1]), alice, 1))).toBe(409);
    const timed = core.createDoc({ name: 'Timed', mode: 'friend', clock: { perMove: 30, perGame: null }, seats: { X: ALICE, O: ALICE } });
    expect(status(() => core.undo(core.move(timed, alice, { game: 0, moveCount: 0, cell: 0 }, 0), alice, 1))).toBe(409);
  });
});

describe('match options and lock', () => {
  it('locks options for both players until the game ends, but not the name', () => {
    let doc = core.lock(onlineDoc(), bob);
    expect(status(() => core.lock(doc, carol))).toBe(403);
    expect(view(doc, alice).locked).toBe(true);
    expect(status(() => core.update(doc, alice, { hideBoard: true }))).toBe(409);
    expect(status(() => core.update(doc, alice, { hideCoordinates: true }))).toBe(409);
    expect(status(() => core.update(doc, alice, { clock: { perMove: 30, perGame: null } }))).toBe(409);
    expect(core.update(doc, alice, { name: 'Renamed' }).name).toBe('Renamed');
    doc = play(doc, X_WINS);
    expect(view(doc, alice).locked).toBe(false);
    expect(core.update(doc, bob, { hideBoard: true }).options.hideBoard).toBe(true);
  });

  it('shares hide coordinates with both players and watchers, and keeps the other options', () => {
    const doc = core.update(core.update(onlineDoc(), bob, { hideHistory: true }), alice, { hideCoordinates: true });
    for (const who of [alice, bob, carol]) expect(view(doc, who).options).toEqual({ hideBoard: false, hideHistory: true, hideCoordinates: true });
    expect(core.update(doc, bob, { hideCoordinates: false }).options).toEqual({ hideBoard: false, hideHistory: true, hideCoordinates: false });
    expect(status(() => core.update(doc, carol, { hideCoordinates: false }))).toBe(403);
  });

  it('keeps the limit of a started game and applies a change from the next game', () => {
    const before = core.update(onlineDoc(), alice, { clock: { perMove: 30, perGame: null } });
    expect(before.games[0]?.clock).toEqual({ perMove: 30, perGame: null });
    const started = play(before, [0]);
    const during = core.update(started, bob, { clock: { perMove: null, perGame: 300 } });
    expect(during.games[0]?.clock).toEqual({ perMove: 30, perGame: null });
    expect(core.newGame(play(during, X_WINS.slice(1), { start: 1 }), alice).games[1]?.clock).toEqual({ perMove: null, perGame: 300 });
  });
});

describe('clock', () => {
  it('records a timeout once the player to move runs out', () => {
    const doc = play(onlineDoc({ perMove: 10, perGame: null }), [0, 1, 2], { at: (i) => [0, 60_000, 69_000][i] ?? 0 });
    // O has 10 s from X's move at 69 s. At 0 ms left the time is over.
    expect(core.settle(doc, 78_999)).toBeUndefined();
    const settled = core.settle(doc, 79_000);
    expect(settled?.games[0]?.timedOut).toBe(true);
    expect(status(() => core.move(settled as SessionDoc, bob, { game: 0, moveCount: 3, cell: 3 }, 79_002))).toBe(409);
  });
});

describe('chat', () => {
  it('lets the two players write, from their own seat, and keeps the newest messages', () => {
    let doc = core.chat(onlineDoc(), alice, '  good luck ', 5);
    doc = core.chat(doc, bob, 'you too', 6);
    expect(doc.chat).toEqual([
      { id: 1, from: 'X', text: 'good luck', at: 5 },
      { id: 2, from: 'O', text: 'you too', at: 6 },
    ]);
    expect(status(() => core.chat(doc, carol, 'hi', 7))).toBe(403);
    expect(status(() => core.chat(doc, alice, '   ', 7))).toBe(400);
    expect(status(() => core.chat(doc, alice, 'x'.repeat(201), 7))).toBe(400);
    for (let i = 0; i < 60; i++) doc = core.chat(doc, alice, `m${i}`, i);
    expect(doc.chat).toHaveLength(50);
    expect(doc.chat.at(-1)).toMatchObject({ id: 62, text: 'm59' });
  });
});

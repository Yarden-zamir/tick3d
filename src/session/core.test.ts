import { describe, expect, it } from 'vitest';
import { toEpochMs as ms } from '../epoch.ts';
import type { TimeControl } from '../clock.ts';
import { nameOf } from '../names.ts';
import { CHAT_KEEP, CHAT_MAX_LENGTH, type Code, seatIn } from '../protocol.ts';
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
    return core.move(current, who, { game: current.games.length - 1, moveCount, cell }, ms(at(moveCount)));
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
    now: ms(0),
    audience: { presence: { X: true, O: false }, watchers: [], name: nameOf },
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
    const next = core.move(core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0)), alice, { game: 0, moveCount: 1, cell: 1 }, ms(1));
    expect(next.games[0]?.moves).toEqual([0, 1]);
  });

  it('lets the device move for the computer only with the computer token', () => {
    const doc = core.createDoc({
      name: 'Versus',
      mode: 'computer',
      seats: { X: ALICE, O: core.COMPUTER_TOKEN },
      computer: { difficulty: 'hard', seat: 'O' },
    });
    const afterX = core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0));
    expect(status(() => core.move(afterX, alice, { game: 0, moveCount: 1, cell: 1 }, ms(1)))).toBe(409);
    const device = new Set([ALICE, core.COMPUTER_TOKEN]);
    expect(core.move(afterX, device, { game: 0, moveCount: 1, cell: 1 }, ms(1)).games[0]?.moves).toEqual([0, 1]);
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
    expect(status(() => core.move(doc, carol, { game: 0, moveCount: 0, cell: 0 }, ms(0)))).toBe(403);
    expect(status(() => core.move(doc, bob, { game: 0, moveCount: 0, cell: 0 }, ms(0)))).toBe(409);
    const one = core.move(doc, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0));
    expect(status(() => core.move(one, bob, { game: 0, moveCount: 0, cell: 1 }, ms(1)))).toBe(409);
    expect(status(() => core.move(one, bob, { game: 0, moveCount: 1, cell: 0 }, ms(1)))).toBe(409);
    expect(core.move(one, bob, { game: 0, moveCount: 1, cell: 1 }, ms(1)).games[0]?.moves).toEqual([0, 1]);
  });

  it('marks a repeat of a move that counted as already-played, and only that', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        if (error instanceof core.SessionError) return [error.status, error.code];
        throw error;
      }
      return undefined;
    };
    const first = { game: 0, moveCount: 0, cell: 21 };
    const one = core.move(onlineDoc(), alice, first, ms(0));
    expect(codeOf(() => core.move(one, alice, first, ms(1)))).toEqual([409, 'already-played']);
    // Also after the other player answered, and after the game ended.
    const two = core.move(one, bob, { game: 0, moveCount: 1, cell: 5 }, ms(1));
    expect(codeOf(() => core.move(two, alice, first, ms(2)))).toEqual([409, 'already-played']);
    // Another cell, or the other player sending the same request, is a real conflict.
    expect(codeOf(() => core.move(one, alice, { ...first, cell: 22 }, ms(1)))).toEqual([409, undefined]);
    expect(codeOf(() => core.move(one, bob, first, ms(1)))).toEqual([409, undefined]);
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
    const given = core.newGame(core.move(local, alice, { game: 0, moveCount: 0, cell: 5 }, ms(0)), alice);
    expect(given.games.map((game) => game.moves)).toEqual([[5], []]);
  });

  it('replaces an empty live game instead of stacking empty games', () => {
    const doc = onlineDoc();
    expect(core.newGame(doc, alice).games).toHaveLength(1);
  });

  it('undoes moves on one device only, and never in a timed game', () => {
    const local = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    const two = core.move(core.move(local, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0)), alice, { game: 0, moveCount: 1, cell: 1 }, ms(1));
    expect(core.undo(two, alice, 1).games[0]?.moves).toEqual([0]);
    expect(status(() => core.undo(play(onlineDoc(), [0, 1]), alice, 1))).toBe(409);
    const timed = core.createDoc({ name: 'Timed', mode: 'friend', clock: { perMove: 30, perGame: null }, seats: { X: ALICE, O: ALICE } });
    expect(status(() => core.undo(core.move(timed, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0)), alice, 1))).toBe(409);
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

  it('waits for the second player, and holds a new game and an undo until the game ends', () => {
    const alone = core.createDoc({ name: 'Match', mode: 'online', seats: { X: ALICE, O: null } });
    expect(status(() => core.lock(alone, alice))).toBe(409);
    const locked = core.lock(play(onlineDoc(), [0]), alice);
    expect(status(() => core.newGame(locked, alice))).toBe(409);
    const couch = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    const lockedCouch = core.lock(core.move(couch, alice, { game: 0, moveCount: 0, cell: 0 }, ms(0)), alice);
    expect(status(() => core.newGame(lockedCouch, alice))).toBe(409);
    expect(status(() => core.undo(lockedCouch, alice, 1))).toBe(409);
    expect(core.lock(lockedCouch, alice)).toBe(lockedCouch);
  });

  it('ends the lock when the game ends on time', () => {
    const timed = core.lock(onlineDoc({ perMove: 5, perGame: null }), alice);
    const started = play(timed, [0, 1]);
    expect(view(started, alice).locked).toBe(true);
    const settled = core.settle(started, ms(60_000));
    if (settled === undefined) throw new Error('no timeout');
    expect(view(settled, alice).locked).toBe(false);
    expect(core.newGame(settled, alice).games).toHaveLength(2);
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
    expect(core.settle(doc, ms(78_999))).toBeUndefined();
    const settled = core.settle(doc, ms(79_000));
    expect(settled?.games[0]?.timedOut).toBe(true);
    expect(status(() => core.move(settled as SessionDoc, bob, { game: 0, moveCount: 3, cell: 3 }, ms(79_002)))).toBe(409);
  });
});

describe('chat', () => {
  it('lets the two players write, from their own seat, and keeps the newest messages', () => {
    let doc = core.chat(onlineDoc(), alice, '  good luck ', ms(5));
    doc = core.chat(doc, bob, 'you too', ms(6));
    expect(doc.chat).toEqual([
      { id: 1, from: 'X', text: 'good luck', at: 5 },
      { id: 2, from: 'O', text: 'you too', at: 6 },
    ]);
    expect(status(() => core.chat(doc, carol, 'hi', ms(7)))).toBe(403);
    expect(status(() => core.chat(doc, alice, '   ', ms(7)))).toBe(400);
    expect(status(() => core.chat(doc, alice, 'x'.repeat(CHAT_MAX_LENGTH + 1), ms(7)))).toBe(400);
    const sent = CHAT_KEEP + 10;
    for (let i = 0; i < sent; i++) doc = core.chat(doc, alice, `m${i}`, ms(i));
    expect(doc.chat).toHaveLength(CHAT_KEEP);
    // Two messages came before the loop, so the ids go on from 3.
    expect(doc.chat.at(-1)).toMatchObject({ id: sent + 2, text: `m${sent - 1}` });
  });
});

describe('seat controls', () => {
  // Carol has the game open without a seat. The holder gives her an opaque id.
  const watchers: core.OpenWatcher[] = [{ id: 'c0ffee0000000001', token: CAROL, player: null }];

  it('applies a change of the own seat or of an empty seat at once', () => {
    const doc = onlineDoc();
    const left = core.seat(doc, bob, { action: 'leave' }, watchers, ms(0));
    expect(left.seats).toEqual({ X: ALICE, O: null });
    const seated = core.seat(left, alice, { action: 'seat', watcher: 'c0ffee0000000001' }, watchers, ms(0));
    expect(seated.seats).toEqual({ X: ALICE, O: CAROL });
    const given = core.seat(doc, alice, { action: 'give', watcher: 'c0ffee0000000001' }, watchers, ms(0));
    expect(given.seats).toEqual({ X: CAROL, O: BOB });
    // With the other seat empty, a swap affects nobody: the player moves to the other side.
    expect(core.seat(left, alice, { action: 'swap' }, watchers, ms(0)).seats).toEqual({ X: null, O: ALICE });
  });

  it('asks the other player before a swap, an unseat or a replace, and applies it on accept', () => {
    const doc = play(onlineDoc(), [0, 1, 2]);
    for (const [request, seats] of [
      [{ action: 'swap' }, { X: BOB, O: ALICE }],
      [{ action: 'unseat' }, { X: ALICE, O: null }],
      [{ action: 'replace', watcher: 'c0ffee0000000001' }, { X: ALICE, O: CAROL }],
    ] as const) {
      const asked = core.seat(doc, alice, request, watchers, ms(1_000));
      expect(asked.seats).toEqual(doc.seats);
      expect(view(asked, bob).seatRequest).toMatchObject({ kind: request.action, from: 'X', expiresAt: 1_000 + core.SEAT_REQUEST_MS });
      const accepted = core.answerSeat(asked, bob, true, watchers, ms(2_000));
      expect(accepted.seats).toEqual(seats);
      expect(accepted.seatRequest).toBeNull();
      // A swap in the middle of a game keeps the moves and their times: each clock stays with its seat.
      expect(accepted.games).toEqual(doc.games);
    }
  });

  it('lets the other player decline and the asker cancel, but only the other player accept', () => {
    const asked = core.seat(onlineDoc(), alice, { action: 'swap' }, watchers, ms(0));
    expect(status(() => core.answerSeat(asked, alice, true, watchers, ms(1)))).toBe(409);
    expect(core.answerSeat(asked, alice, false, watchers, ms(1)).seatRequest).toBeNull();
    const declined = core.answerSeat(asked, bob, false, watchers, ms(1));
    expect(declined.seatRequest).toBeNull();
    expect(declined.seats).toEqual(asked.seats);
    // One request at a time: the other player answers first, and a new request from the asker replaces the old one.
    expect(status(() => core.seat(asked, bob, { action: 'swap' }, watchers, ms(1)))).toBe(409);
    expect(core.seat(asked, alice, { action: 'unseat' }, watchers, ms(5)).seatRequest).toMatchObject({ kind: 'unseat', at: 5 });
  });

  it('drops a request after it ends, and refuses an answer to it', () => {
    const asked = core.seat(onlineDoc(), alice, { action: 'swap' }, watchers, ms(0));
    const end = core.SEAT_REQUEST_MS;
    expect(core.settle(asked, ms(end - 1))).toBeUndefined();
    expect(core.settle(asked, ms(end))?.seatRequest).toBeNull();
    expect(view(asked, bob).seatRequest).not.toBeNull();
    expect(status(() => core.answerSeat(asked, bob, true, watchers, ms(end)))).toBe(409);
  });

  it('checks a replace again on accept: the watcher must still be here without a seat', () => {
    const asked = core.seat(onlineDoc(), alice, { action: 'replace', watcher: 'c0ffee0000000001' }, watchers, ms(0));
    expect(status(() => core.answerSeat(asked, bob, true, [], ms(1)))).toBe(409);
    expect(core.answerSeat(asked, bob, true, watchers, ms(1)).seats.O).toBe(CAROL);
  });

  it('refuses watchers, unknown watchers, wrong seats and games on one device', () => {
    const doc = onlineDoc();
    for (const request of [{ action: 'swap' }, { action: 'leave' }] as const) {
      expect(status(() => core.seat(doc, carol, request, watchers, ms(0)))).toBe(403);
    }
    expect(status(() => core.answerSeat(core.seat(doc, alice, { action: 'swap' }, watchers, ms(0)), carol, true, watchers, ms(1)))).toBe(403);
    expect(status(() => core.seat(doc, alice, { action: 'give', watcher: 'ffffffffffffffff' }, watchers, ms(0)))).toBe(404);
    expect(status(() => core.seat(doc, alice, { action: 'seat', watcher: 'c0ffee0000000001' }, watchers, ms(0)))).toBe(409);
    const left = core.seat(doc, bob, { action: 'leave' }, watchers, ms(0));
    expect(status(() => core.seat(left, alice, { action: 'unseat' }, watchers, ms(0)))).toBe(409);
    expect(status(() => core.seat(left, alice, { action: 'replace', watcher: 'c0ffee0000000001' }, watchers, ms(0)))).toBe(409);
    expect(status(() => core.answerSeat(doc, alice, true, watchers, ms(0)))).toBe(409);
    const couch = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    expect(status(() => core.seat(couch, alice, { action: 'swap' }, watchers, ms(0)))).toBe(409);
  });

  it('takes back the own last move when the other player accepts, before the other player moves', () => {
    const doc = play(onlineDoc(), [0, 1, 2]);
    // X moved last. O cannot ask, X can.
    expect(status(() => core.seat(doc, bob, { action: 'undo' }, watchers, ms(0)))).toBe(409);
    expect(status(() => core.seat(doc, carol, { action: 'undo' }, watchers, ms(0)))).toBe(403);
    const asked = core.seat(doc, alice, { action: 'undo' }, watchers, ms(0));
    expect(asked.games).toEqual(doc.games);
    expect(core.answerSeat(asked, bob, true, watchers, ms(1)).games[0]?.moves).toEqual([0, 1]);
    expect(core.answerSeat(asked, bob, false, watchers, ms(1)).games[0]?.moves).toEqual([0, 1, 2]);
    // A move of the other player ends the request: the move is not the last one any more.
    const moved = core.move(asked, bob, { game: 0, moveCount: 3, cell: 3 }, ms(2));
    expect(moved.seatRequest).toBeNull();
    expect(status(() => core.answerSeat(moved, bob, true, watchers, ms(3)))).toBe(409);
  });

  it('allows no undo in a timed game, a finished game or before a move', () => {
    expect(status(() => core.seat(play(onlineDoc({ perMove: 30, perGame: null }), [0]), alice, { action: 'undo' }, watchers, ms(0)))).toBe(409);
    expect(status(() => core.seat(play(onlineDoc(), X_WINS), alice, { action: 'undo' }, watchers, ms(0)))).toBe(409);
    expect(status(() => core.seat(onlineDoc(), alice, { action: 'undo' }, watchers, ms(0)))).toBe(409);
  });

  it('lists watchers by id and name only, never by token', () => {
    const asked = core.seat(onlineDoc(), alice, { action: 'replace', watcher: 'c0ffee0000000001' }, watchers, ms(0));
    const shown = core.viewOf(asked, {
      code: 'ABCD' as Code,
      version: 1,
      identity: bob,
      now: ms(1),
      audience: { presence: { X: true, O: true }, watchers, name: (token) => (token === CAROL ? 'Carol' : nameOf(token)) },
      players: { X: null, O: null },
    });
    expect(shown.watchers).toEqual([{ id: 'c0ffee0000000001', name: 'Carol', player: null }]);
    expect(shown.youWatcher).toBeNull();
    expect(shown.seatRequest?.watcher).toEqual({ name: 'Carol', player: null });
    expect(JSON.stringify(shown)).not.toContain(CAROL);
  });

  it('ends a sound playoff when a seat changes hands, so a new seat holder does not take over its progress', () => {
    const doc = onlineDoc();
    const started = core.playoff(doc, alice, { action: 'start', preset: 'easy', seed: 7 }, ms(0));
    expect(started.playoff).not.toBeNull();
    for (const [who, request] of [
      [bob, { action: 'leave' }],
      [alice, { action: 'give', watcher: 'c0ffee0000000001' }],
    ] as const) {
      expect(core.seat(started, who, request, watchers, ms(0)).playoff, request.action).toBeNull();
    }
    for (const request of [{ action: 'unseat' }, { action: 'replace', watcher: 'c0ffee0000000001' }] as const) {
      const asked = core.seat(started, alice, request, watchers, ms(0));
      // A request alone changes no seat, so the playoff goes on until the other player accepts.
      expect(asked.playoff, request.action).toEqual(started.playoff);
      expect(core.answerSeat(asked, bob, true, watchers, ms(0)).playoff, request.action).toBeNull();
    }
    // A swap keeps the same two players, so the playoff goes on with them.
    const swapped = core.answerSeat(core.seat(started, alice, { action: 'swap' }, watchers, ms(0)), bob, true, watchers, ms(0));
    const before = started.playoff;
    if (before === null) throw new Error('the playoff did not start');
    expect(swapped.playoff).toEqual({ ...before, by: 'O', seats: { X: before.seats.O, O: before.seats.X } });
    // An undo changes no seat, and keeps the playoff.
    const played = play(started, [0, 1]);
    const undone = core.answerSeat(core.seat(played, bob, { action: 'undo' }, watchers, ms(0)), alice, true, watchers, ms(0));
    expect(undone.playoff).toEqual(started.playoff);
  });
});

describe('seat rotation', () => {
  const watchers: core.OpenWatcher[] = [{ id: 'c0ffee0000000001', token: CAROL, player: null }];
  // Plays the cells in the live game. The player on the seat to move makes each move.
  const playSeats = (doc: SessionDoc, cells: number[]): SessionDoc =>
    cells.reduce((current, cell) => {
      const game = core.currentGame(current);
      const holder = current.seats[game.turn];
      if (holder === null) throw new Error(`seat ${game.turn} is empty`);
      return core.move(current, new Set([holder]), { game: current.games.length - 1, moveCount: game.moves.length, cell }, ms(0));
    }, doc);
  // Alice (X) wins game 1.
  const afterGame = () => play(onlineDoc(), X_WINS);

  it('keeps a sound playoff with its players through the swap of a new game', () => {
    const started = core.playoff(afterGame(), alice, { action: 'start', preset: 'easy', seed: 7 }, ms(0));
    const joined = core.playoff(started, bob, { action: 'join', id: 1 }, ms(0));
    const before = joined.playoff;
    if (before === null) throw new Error('the playoff did not start');
    const second = core.newGame(joined, bob);
    expect(second.seats).toEqual({ X: BOB, O: ALICE });
    // Alice started the playoff as X, and holds O now: her progress and her start move with her.
    expect(second.playoff).toEqual({ ...before, by: 'O', seats: { X: before.seats.O, O: before.seats.X } });
  });

  it('swaps X and O for each new game by default, so the player who was O moves first', () => {
    const second = core.newGame(afterGame(), bob);
    expect(second.seats).toEqual({ X: BOB, O: ALICE });
    expect(view(second, alice)).toMatchObject({ you: 'O', fixedSeats: false, flipped: [true, false], turn: 'X' });
    expect(view(second, bob).you).toBe('X');
    expect(status(() => core.move(second, alice, { game: 1, moveCount: 0, cell: 0 }, ms(0)))).toBe(409);
    // Game 1 keeps its player: Alice holds O now, and she played X in game 1.
    expect(seatIn(second.flipped, 0, 'O')).toBe('X');
    const third = core.newGame(playSeats(second, X_WINS), alice);
    expect(third.seats).toEqual({ X: ALICE, O: BOB });
    expect(third.flipped).toEqual([false, true, false]);
  });

  it('keeps the seats when a player locks them, and only a player can change the lock', () => {
    const fixed = core.update(afterGame(), bob, { fixedSeats: true });
    expect(view(fixed, carol).fixedSeats).toBe(true);
    const next = core.newGame(fixed, alice);
    expect(next.seats).toEqual({ X: ALICE, O: BOB });
    expect(next.flipped).toEqual([false, false]);
    expect(status(() => core.update(fixed, carol, { fixedSeats: false }))).toBe(403);
    expect(core.update(fixed, alice, { fixedSeats: false }).fixedSeats).toBe(false);
  });

  it('holds the seat lock during a settings lock, and rotates a timed session after a timeout', () => {
    const locked = core.lock(play(onlineDoc(), [0]), bob);
    expect(status(() => core.update(locked, alice, { fixedSeats: true }))).toBe(409);
    const timed = core.lock(onlineDoc({ perMove: 5, perGame: null }), alice);
    const settled = core.settle(play(timed, [0, 1]), ms(60_000));
    if (settled === undefined) throw new Error('no timeout');
    // The lock ended with the game. The next game rotates and keeps the time limit.
    const next = core.newGame(settled, bob);
    expect(next.seats).toEqual({ X: BOB, O: ALICE });
    expect(next.games[1]?.clock).toEqual({ perMove: 5, perGame: null });
  });

  it('does not swap for an empty game nor in a friend game, and keeps the computer seats until the player unlocks them', () => {
    expect(core.newGame(onlineDoc(), alice).seats).toEqual({ X: ALICE, O: BOB });
    const couch = core.createDoc({ name: 'Couch', mode: 'friend', seats: { X: ALICE, O: ALICE } });
    expect(core.newGame(core.move(couch, alice, { game: 0, moveCount: 0, cell: 5 }, ms(0)), alice).flipped).toEqual([false, false]);
    const versus = core.createDoc({ name: 'Versus', mode: 'computer', seats: { X: ALICE, O: core.COMPUTER_TOKEN }, computer: { difficulty: 'easy', seat: 'O' } });
    const played = core.move(versus, alice, { game: 0, moveCount: 0, cell: 5 }, ms(0));
    // Against the computer the player starts every game by default.
    expect(versus.fixedSeats).toBe(true);
    expect(core.newGame(played, alice).seats).toEqual(versus.seats);
    // Unlocked, the computer moves with its seat. On one device a player can give up a game: the next game rotates too.
    const next = core.newGame(core.update(played, alice, { fixedSeats: false }), alice);
    expect(next.seats).toEqual({ X: core.COMPUTER_TOKEN, O: ALICE });
    expect(next.computer).toEqual({ difficulty: 'easy', seat: 'X' });
    expect(view(next, alice).you).toBe('O');
  });

  it('follows a swap during a game, and a give after it, into the next game', () => {
    // Alice and Bob swap during game 1. Bob holds X when X wins, so the win is his.
    const asked = core.seat(play(onlineDoc(), [0, 1, 2]), alice, { action: 'swap' }, watchers, ms(0));
    const swapped = playSeats(core.answerSeat(asked, bob, true, watchers, ms(1)), [3, 16, 4, 32, 5, 48]);
    expect(core.currentGame(swapped).status).toMatchObject({ kind: 'won', winner: 'X' });
    const next = core.newGame(swapped, alice);
    expect(next.seats).toEqual({ X: ALICE, O: BOB });
    expect(seatIn(next.flipped, 0, 'X')).toBe('O');
    // Alice gives her seat to Carol after game 1. Carol rotates with the seat, and Alice keeps watching.
    const given = core.seat(afterGame(), alice, { action: 'give', watcher: 'c0ffee0000000001' }, watchers, ms(0));
    const afterGive = core.newGame(given, bob);
    expect(afterGive.seats).toEqual({ X: BOB, O: CAROL });
    expect(view(afterGive, alice).you).toBeNull();
  });

  it('keeps a pending seat request with its player', () => {
    const asked = core.seat(afterGame(), alice, { action: 'swap' }, watchers, ms(0));
    const next = core.newGame(asked, bob);
    // Alice asked as X. She is O now, so the request is from O, and Bob still answers it.
    expect(view(next, bob).seatRequest).toMatchObject({ kind: 'swap', from: 'O' });
    expect(core.answerSeat(next, bob, true, watchers, ms(1)).seats).toEqual({ X: ALICE, O: BOB });
  });

  it('keeps each chat message with its writer across a swap', () => {
    const next = core.newGame(core.chat(afterGame(), alice, 'Again?', ms(0)), bob);
    expect(next.chat.map((message) => message.from)).toEqual(['O']);
    expect(view(next, alice).you).toBe('O');
  });
});

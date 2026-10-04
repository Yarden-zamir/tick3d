import { describe, expect, it } from 'vitest';
import { type TimeControl, describeClock, formatClock, isFlagged, parseClock, remaining } from './clock.ts';
import { type Game, newGame, play, timeOut } from './game.ts';

function playAt(clock: TimeControl, moves: [cell: number, at: number][]): Game {
  return moves.reduce((game, [cell, at]) => {
    const result = play(game, cell, at);
    if (!result.ok) throw new Error(result.error);
    return result.game;
  }, newGame('X', clock));
}

const perMove: TimeControl = { perMove: 10, perGame: null };
const perGame: TimeControl = { perMove: null, perGame: 60 };
const both: TimeControl = { perMove: 10, perGame: 60 };

describe('remaining', () => {
  it('is null without a time limit', () => {
    expect(remaining(newGame(), 0)).toBeNull();
  });

  it('does not run before both players moved once', () => {
    const game = playAt(perMove, [[0, 0]]);
    expect(remaining(game, 999_999)?.X.left).toBe(10_000);
    expect(isFlagged(game, 999_999)).toBe(false);
  });

  it('runs per move for the player to move only', () => {
    const game = playAt(perMove, [[0, 0], [1, 50_000]]);
    expect(remaining(game, 56_000)).toEqual({
      X: { left: 4_000, game: null, move: 4_000 },
      O: { left: 10_000, game: null, move: 10_000 },
    });
    expect(isFlagged(game, 60_000)).toBe(true);
  });

  it('adds up time per player for a game limit', () => {
    // X spends 20 s on move 3, O spends 5 s on move 4, and X has used 10 s more at t = 85 s.
    const game = playAt(perGame, [[0, 0], [1, 50_000], [2, 70_000], [3, 75_000]]);
    expect(remaining(game, 85_000)?.X.left).toBe(30_000);
    expect(remaining(game, 85_000)?.O.left).toBe(55_000);
  });

  it('with both limits, the first one to run out decides', () => {
    // The move limit decides while the bank is full.
    const fresh = playAt(both, [[0, 0], [1, 1_000]]);
    expect(remaining(fresh, 9_000)?.X).toEqual({ left: 2_000, game: 52_000, move: 2_000 });
    expect(isFlagged(fresh, 11_001)).toBe(true);
    // X spends 9 s on each of 3 timed moves: 27 s of 30. The bank of 3 s decides before the 10 s move limit.
    const tired = playAt({ perMove: 10, perGame: 30 }, [
      [0, 0], [1, 1_000], [2, 10_000], [3, 11_000], [17, 20_000], [20, 21_000], [40, 30_000], [50, 31_000],
    ]);
    expect(tired.status.kind).toBe('playing');
    expect(remaining(tired, 31_000)?.X).toEqual({ left: 3_000, game: 3_000, move: 10_000 });
    expect(isFlagged(tired, 34_001)).toBe(true);
  });

  it('stops for a finished game and shows 0 for the player out of time', () => {
    const game = timeOut(playAt(perMove, [[0, 0], [1, 1_000]]));
    expect(remaining(game, 999_999)?.X.left).toBe(0);
    expect(remaining(game, 999_999)?.O.left).toBe(10_000);
    expect(isFlagged(game, 999_999)).toBe(false);
  });
});

describe('parseClock', () => {
  it('accepts whole seconds inside the ranges, or null', () => {
    expect(parseClock({ perMove: 45, perGame: 330 })).toEqual({ perMove: 45, perGame: 330 });
    expect(parseClock({ perMove: null, perGame: null })).toEqual({ perMove: null, perGame: null });
  });

  it.each([
    { perMove: 2, perGame: null },
    { perMove: 601, perGame: null },
    { perMove: null, perGame: 29 },
    { perMove: 10.5, perGame: null },
    { perMove: '10', perGame: null },
    { perMove: 10 },
    null,
  ])('rejects %j', (value) => {
    expect(parseClock(value)).toBeUndefined();
  });
});

describe('describeClock', () => {
  it('names both limits', () => {
    expect(describeClock({ perMove: 30, perGame: 300 })).toBe('5 min per player + 30 s per move');
    expect(describeClock({ perMove: null, perGame: 90 })).toBe('1 min 30 s per player');
    expect(describeClock({ perMove: null, perGame: null })).toBe('No time limit');
  });
});

describe('formatClock', () => {
  it('rounds up to whole seconds and never goes below zero', () => {
    expect(formatClock(61_200)).toBe('1:02');
    expect(formatClock(-5)).toBe('0:00');
  });
});

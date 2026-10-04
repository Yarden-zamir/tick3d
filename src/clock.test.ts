import { describe, expect, it } from 'vitest';
import { type TimeControl, formatClock, isFlagged, parseClock, remaining } from './clock.ts';
import { type Game, newGame, play, timeOut } from './game.ts';

function playAt(moves: [cell: number, at: number][]): Game {
  return moves.reduce((game, [cell, at]) => {
    const result = play(game, cell, at);
    if (!result.ok) throw new Error(result.error);
    return result.game;
  }, newGame());
}

const perMove: TimeControl = { kind: 'move', seconds: 10 };
const perGame: TimeControl = { kind: 'game', seconds: 60 };

describe('remaining', () => {
  it('is null without a time limit', () => {
    expect(remaining({ kind: 'off' }, newGame(), 0)).toBeNull();
  });

  it('does not run before both players moved once', () => {
    const game = playAt([[0, 0]]);
    expect(remaining(perMove, game, 999_999)).toEqual({ X: 10_000, O: 10_000 });
    expect(isFlagged(perMove, game, 999_999)).toBe(false);
  });

  it('runs per move for the player to move only', () => {
    const game = playAt([[0, 0], [1, 50_000]]);
    expect(remaining(perMove, game, 56_000)).toEqual({ X: 4_000, O: 10_000 });
    expect(isFlagged(perMove, game, 60_000)).toBe(true);
  });

  it('adds up time per player for a game clock', () => {
    // X spends 20 s on move 3, O spends 5 s on move 4, X has used 30 s by t = 85 s.
    const game = playAt([[0, 0], [1, 50_000], [2, 70_000], [3, 75_000]]);
    expect(remaining(perGame, game, 85_000)).toEqual({ X: 30_000, O: 55_000 });
  });

  it('stops for a finished game and shows 0 for the player out of time', () => {
    const game = timeOut(playAt([[0, 0], [1, 1_000]]));
    expect(remaining(perMove, game, 999_999)).toEqual({ X: 0, O: 10_000 });
    expect(isFlagged(perMove, game, 999_999)).toBe(false);
  });
});

describe('parseClock', () => {
  it('accepts presets by key or object only', () => {
    expect(parseClock('game:300')).toEqual({ kind: 'game', seconds: 300 });
    expect(parseClock({ kind: 'move', seconds: 10 })).toEqual({ kind: 'move', seconds: 10 });
    expect(parseClock({ kind: 'off' })).toEqual({ kind: 'off' });
    expect(parseClock('move:11')).toBeUndefined();
    expect(parseClock({ kind: 'game', seconds: 1 })).toBeUndefined();
    expect(parseClock(null)).toBeUndefined();
  });
});

describe('formatClock', () => {
  it('rounds up to whole seconds and never goes below zero', () => {
    expect(formatClock(61_200)).toBe('1:02');
    expect(formatClock(-5)).toBe('0:00');
  });
});

import { describe, expect, it } from 'vitest';
import { CELL_COUNT, LINES, type Game, newGame, play, toCell, undo } from './game';

function playAll(cells: number[], game: Game = newGame()): Game {
  return cells.reduce((current, cell) => {
    const result = play(current, cell);
    if (!result.ok) throw new Error(`move ${cell} failed: ${result.error}`);
    return result.game;
  }, game);
}

describe('lines', () => {
  it('has all 76 distinct lines of 4 distinct cells', () => {
    expect(LINES).toHaveLength(76);
    const keys = new Set(LINES.map((line) => [...line].sort((a, b) => a - b).join(',')));
    expect(keys.size).toBe(76);
    for (const line of LINES) expect(new Set(line).size).toBe(4);
  });

  it('includes a space diagonal and a vertical diagonal', () => {
    const has = (cells: number[]) => LINES.some((line) => cells.every((c) => line.includes(c)));
    const at = (layer: number, row: number, column: number) => toCell({ layer, row, column });
    expect(has([at(0, 0, 3), at(1, 1, 2), at(2, 2, 1), at(3, 3, 0)])).toBe(true);
    expect(has([at(0, 2, 0), at(1, 2, 1), at(2, 2, 2), at(3, 2, 3)])).toBe(true);
  });
});

describe('play', () => {
  it('alternates turns starting with the first player', () => {
    const game = playAll([0]);
    expect(game.turn).toBe('O');
    expect(game.board[0]).toBe('X');
  });

  it('rejects an occupied cell without changing the game', () => {
    const game = playAll([5]);
    expect(play(game, 5)).toEqual({ ok: false, error: 'occupied' });
  });

  it('throws on a cell outside the board', () => {
    expect(() => play(newGame(), CELL_COUNT)).toThrow(RangeError);
    expect(() => play(newGame(), 1.5)).toThrow(RangeError);
  });

  it('detects a win through the layers and then rejects moves', () => {
    const column = [0, 16, 32, 48];
    const game = playAll([column[0]!, 1, column[1]!, 2, column[2]!, 3, column[3]!]);
    expect(game.status).toEqual({ kind: 'won', winner: 'X', line: column });
    expect(play(game, 10)).toEqual({ ok: false, error: 'game-over' });
  });
});

describe('undo', () => {
  it('replays to the earlier position', () => {
    const game = playAll([0, 1, 2]);
    expect(undo(game, 2)).toEqual(playAll([0]));
    expect(undo(game, 10)).toEqual(newGame());
  });
});

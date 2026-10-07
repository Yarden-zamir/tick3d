import { describe, expect, it } from 'vitest';
import { toEpochMs as ms } from './epoch.ts';
import { CELL_COUNT, LINES, type Game, lineKind, linesThrough, newGame, parseCoordinates, play, replay, timeOut, toCell, undo } from './game.ts';

// Move i happens at time i, so results compare equal across calls.
function playAll(cells: number[], game: Game = newGame()): Game {
  return cells.reduce((current, cell, i) => {
    const result = play(current, cell, ms(i));
    if (!result.ok) throw new Error(`move ${cell} failed: ${result.error}`);
    return result.game;
  }, game);
}

// Plays a full board in X-first turn order: X marks and O marks alternate, with `last` as the final move.
function fullGame(board: string, last?: number): Game {
  const cellsOf = (mark: string) => [...board].flatMap((value, cell) => (value === mark && cell !== last ? [cell] : []));
  const xs = cellsOf('X');
  const os = last === undefined ? cellsOf('O') : [...cellsOf('O'), last];
  return playAll(xs.flatMap((x, i) => [x, os[i] ?? -1]));
}

describe('a full cube', () => {
  // Found by a local search: 32 X and 32 O with no line of one mark.
  const DRAW = 'XXOXOOXOXOXXXXOXOOXOOXOXXOXXXOOXOOXOXXXOXOOXOXOOOOXXOXOOOXXOXOXO';
  // Exactly one line of O, and cell 54 is on it: no line exists until the 64th move.
  const WIN_ON_LAST = 'XXXOXOOXOOOXXXOXXOOXOXOOXXOOOXXOOXXOXOOXOOXXXOXXOXXOOXOXXOOOXOXO';

  it('is a draw when no line is complete', () => {
    expect(fullGame(DRAW).status.kind).toBe('draw');
  });

  it('is a win, not a draw, when the 64th move completes a line', () => {
    const game = fullGame(WIN_ON_LAST, 54);
    expect(game.moves).toHaveLength(CELL_COUNT);
    expect(game.status).toMatchObject({ kind: 'won', winner: 'O' });
  });

  it('puts every cell on 4 or 7 lines, with 16 strong cells on 7', () => {
    const counts = Array.from({ length: CELL_COUNT }, (_, cell) => linesThrough(cell).length);
    expect(counts.every((count) => count === 4 || count === 7)).toBe(true);
    expect(counts.filter((count) => count === 7)).toHaveLength(16);
  });
});

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

describe('parseCoordinates', () => {
  it.each(['234', '2 3 4', '2,3,4', ' 2, 3, 4 '])('reads %j as layer 2, row 3, column 4', (text) => {
    expect(parseCoordinates(text)).toEqual({ layer: 1, row: 2, column: 3 });
  });

  it.each(['', '23', '2345', '054', '2 3 5', 'abc', '2.3.4'])('rejects %j', (text) => {
    expect(parseCoordinates(text)).toBeUndefined();
  });
});

describe('replay', () => {
  it('throws on an illegal history', () => {
    expect(() => replay([0, 0])).toThrow();
  });
});

describe('timeOut', () => {
  it('gives the win to the player who did not run out of time', () => {
    const game = timeOut(playAll([0, 1, 2]));
    expect(game.status).toEqual({ kind: 'timeout', winner: 'X' });
    expect(play(game, 5)).toEqual({ ok: false, error: 'game-over' });
    expect(() => timeOut(game)).toThrow();
  });
});

describe('lineKind', () => {
  it('finds 48 axis lines, 24 plane diagonals and 4 space diagonals', () => {
    const kinds = LINES.map(lineKind);
    expect(kinds.filter((kind) => kind === 'axis')).toHaveLength(48);
    expect(kinds.filter((kind) => kind === 'plane')).toHaveLength(24);
    expect(kinds.filter((kind) => kind === 'space')).toHaveLength(4);
  });
});

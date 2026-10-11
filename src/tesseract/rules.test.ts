import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  LINES,
  type Line,
  lineSpan,
  linesThrough,
  newGame,
  parseCoordinates,
  play,
  replay,
  threatCells,
  toCell,
  toCoords,
} from './rules.ts';

const at = (cube: number, layer: number, row: number, column: number) => toCell({ cube, layer, row, column });

describe('cells', () => {
  it('round-trips every cell through its coordinates', () => {
    for (let cell = 0; cell < CELL_COUNT; cell++) expect(toCell(toCoords(cell))).toBe(cell);
    expect(toCoords(255)).toEqual({ cube: 3, layer: 3, row: 3, column: 3 });
    expect(at(1, 0, 0, 0)).toBe(64);
  });

  it('refuses a cell or coordinate off the board', () => {
    expect(() => toCoords(256)).toThrow(RangeError);
    expect(() => toCoords(-1)).toThrow(RangeError);
    expect(() => at(4, 0, 0, 0)).toThrow(RangeError);
  });

  it('reads four 1-based digits as cube, layer, row and column', () => {
    expect(parseCoordinates('2341')).toEqual({ cube: 1, layer: 2, row: 3, column: 0 });
    expect(parseCoordinates('2, 3, 4, 1')).toEqual({ cube: 1, layer: 2, row: 3, column: 0 });
    expect(parseCoordinates('234')).toBeUndefined();
    expect(parseCoordinates('2350')).toBeUndefined();
  });
});

describe('lines', () => {
  it('has all 520 distinct lines of 4 distinct cells', () => {
    expect(LINES).toHaveLength(520);
    const keys = new Set(LINES.map((line) => [...line].sort((a, b) => a - b).join(',')));
    expect(keys.size).toBe(520);
    for (const line of LINES) expect(new Set(line).size).toBe(4);
  });

  // A line that changes k coordinates: choose the k axes, a sign for all but the first, and any start on the others.
  it('splits the lines by how many coordinates change: 256 + 192 + 64 + 8', () => {
    const counts = [1, 2, 3, 4].map((span) => LINES.filter((line) => lineSpan(line) === span).length);
    expect(counts).toEqual([256, 192, 64, 8]);
  });

  it('runs every line in equal steps', () => {
    for (const line of LINES) {
      const step = line[1] - line[0];
      expect(line[2] - line[1]).toBe(step);
      expect(line[3] - line[2]).toBe(step);
    }
  });

  it('includes a line through all four dimensions and one that keeps only the cube fixed', () => {
    const has = (cells: number[]) => LINES.some((line) => cells.every((c) => line.includes(c)));
    expect(has([at(0, 3, 0, 3), at(1, 2, 1, 2), at(2, 1, 2, 1), at(3, 0, 3, 0)])).toBe(true);
    expect(has([at(2, 0, 0, 3), at(2, 1, 1, 2), at(2, 2, 2, 1), at(2, 3, 3, 0)])).toBe(true);
  });

  // A set of axes holds one line through a cell when the cell's values on them are all outer (0 or 3) or
  // all inner (1 or 2). With a outer and b inner values that is (2ᵃ − 1) + (2ᵇ − 1) lines: 15, 8 or 6.
  it('puts 32 strong cells on 15 lines, 128 on 8 and 96 on 6', () => {
    const counts = Array.from({ length: CELL_COUNT }, (_, cell) => linesThrough(cell).length);
    expect([15, 8, 6].map((n) => counts.filter((count) => count === n).length)).toEqual([32, 128, 96]);
    // Each line has 4 cells, so the counts add up to 4 × 520.
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(4 * 520);
  });
});

describe('play', () => {
  // X plays `line` while O plays the first cells of the far cube, which share no line with it.
  function playLine(line: Line) {
    const os = [at(3, 0, 0, 0), at(3, 0, 0, 1), at(3, 0, 1, 0)].filter((c) => !line.includes(c));
    return replay(line.flatMap((x, i) => (i < 3 ? [x, os[i] ?? -1] : [x])));
  }

  it('wins on a line through all four dimensions', () => {
    const line: Line = [at(0, 0, 0, 0), at(1, 1, 1, 1), at(2, 2, 2, 2), at(3, 3, 3, 3)];
    const game = playLine([at(0, 0, 0, 1), at(1, 1, 1, 1), at(2, 2, 2, 1), at(3, 3, 3, 1)]);
    expect(game.status).toMatchObject({ kind: 'won', winner: 'X' });
    expect(lineSpan(line)).toBe(4);
  });

  it('wins along the cube axis: the same cell in all four cubes', () => {
    const game = playLine([at(0, 1, 2, 3), at(1, 1, 2, 3), at(2, 1, 2, 3), at(3, 1, 2, 3)]);
    expect(game.status).toEqual({ kind: 'won', winner: 'X', line: [at(0, 1, 2, 3), at(1, 1, 2, 3), at(2, 1, 2, 3), at(3, 1, 2, 3)] });
  });

  it('refuses a taken cell and any move after the end', () => {
    const first = play(newGame(), 0);
    if (!first.ok) throw new Error('first move failed');
    expect(play(first.game, 0)).toEqual({ ok: false, error: 'occupied' });
    const won = playLine([at(0, 1, 2, 3), at(1, 1, 2, 3), at(2, 1, 2, 3), at(3, 1, 2, 3)]);
    expect(play(won, 100)).toEqual({ ok: false, error: 'game-over' });
  });

  it('alternates turns from the chosen first player', () => {
    const game = replay([0, 1, 2], 'O');
    expect(game.board.slice(0, 3)).toEqual(['O', 'X', 'O']);
    expect(game.turn).toBe('X');
  });
});

describe('threats', () => {
  it('finds the open cell of a line with three marks, across cubes', () => {
    const game = replay([at(0, 0, 0, 0), at(3, 3, 3, 0), at(1, 1, 1, 1), at(3, 3, 2, 0), at(2, 2, 2, 2)]);
    expect(threatCells(game.board, 'X')).toEqual([at(3, 3, 3, 3)]);
    expect(threatCells(game.board, 'O')).toEqual([]);
  });

  it('ignores a line the other player blocked', () => {
    const game = replay([at(0, 0, 0, 0), at(3, 3, 3, 3), at(1, 1, 1, 1), at(3, 3, 2, 0), at(2, 2, 2, 2)]);
    expect(threatCells(game.board, 'X')).not.toContain(at(3, 3, 3, 3));
  });
});

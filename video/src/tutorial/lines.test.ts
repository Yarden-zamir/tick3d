import { describe, expect, it } from 'vitest';
import { CELL_COUNT, LINES, linesThrough } from '../../../src/game.ts';
import { KINDS, MOST_LINES, STRONG_CELLS, isCore, isCorner, kindOf, linesOf } from './lines.ts';

const cells = Array.from({ length: CELL_COUNT }, (_, cell) => cell);

describe('the winning lines', () => {
  it('are 76 lines in 6 kinds: 16 rows, 16 columns, 16 pillars, 8 layer, 16 climbing and 4 space diagonals', () => {
    expect(LINES).toHaveLength(76);
    expect(Object.fromEntries(KINDS.map((kind) => [kind, linesOf(kind).length]))).toEqual({
      row: 16,
      column: 16,
      pillar: 16,
      'layer-diagonal': 8,
      'climbing-diagonal': 16,
      'space-diagonal': 4,
    });
    expect(KINDS.reduce((sum, kind) => sum + linesOf(kind).length, 0)).toBe(LINES.length);
  });

  it('sorts lines by the coordinates that change', () => {
    expect(kindOf([60, 61, 62, 63])).toBe('row');
    expect(kindOf([51, 55, 59, 63])).toBe('column');
    expect(kindOf([14, 30, 46, 62])).toBe('pillar');
    expect(kindOf([48, 53, 58, 63])).toBe('layer-diagonal');
    expect(kindOf([12, 29, 46, 63])).toBe('climbing-diagonal');
    expect(kindOf([0, 21, 42, 63])).toBe('space-diagonal');
  });

  it('puts the 8 corners and the 8 core cells on 7 lines each, and every other cell on 4', () => {
    expect(MOST_LINES).toBe(7);
    expect(cells.filter(isCorner)).toHaveLength(8);
    expect(cells.filter(isCore)).toHaveLength(8);
    expect(STRONG_CELLS).toEqual(cells.filter((cell) => isCorner(cell) || isCore(cell)));
    for (const cell of cells) expect(linesThrough(cell), `cell ${cell}`).toHaveLength(STRONG_CELLS.includes(cell) ? 7 : 4);
  });
});

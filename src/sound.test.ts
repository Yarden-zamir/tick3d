import { describe, expect, it } from 'vitest';
import { CELL_COUNT, toCell } from './game.ts';
import { cellMotif } from './sound.ts';

describe('cell sounds', () => {
  it('gives every cell its own motif', () => {
    const motifs = new Set(Array.from({ length: CELL_COUNT }, (_, cell) => JSON.stringify(cellMotif(cell))));
    expect(motifs.size).toBe(CELL_COUNT);
  });

  it('plays the layer low, the row in the middle and the column high, each rising from 1 to 4', () => {
    const at = (layer: number, row: number, column: number) => cellMotif(toCell({ layer, row, column }));
    const [low, middle, high] = at(0, 0, 0).notes;
    expect(low).toBeLessThan(middle);
    expect(middle).toBeLessThan(high);
    // Each part depends on its own coordinate only, and rises with it.
    for (const position of [1, 2, 3]) {
      expect(at(position, 2, 1).notes[0]).toBeGreaterThan(at(position - 1, 2, 1).notes[0]);
      expect(at(3, position, 1).notes[1]).toBeGreaterThan(at(3, position - 1, 1).notes[1]);
      expect(at(1, 2, position).notes[2]).toBeGreaterThan(at(1, 2, position - 1).notes[2]);
      expect(at(1, 2, position).pan).toBeGreaterThan(at(1, 2, position - 1).pan);
    }
    expect(at(3, 0, 0).notes[1]).toBe(at(0, 0, 0).notes[1]);
  });
});

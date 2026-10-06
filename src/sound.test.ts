import { describe, expect, it } from 'vitest';
import { CELL_COUNT, toCell } from './game.ts';
import { cellSound } from './sound.ts';

describe('cell sounds', () => {
  it('gives every cell its own single sound', () => {
    const sounds = new Set(Array.from({ length: CELL_COUNT }, (_, cell) => JSON.stringify(cellSound(cell))));
    expect(sounds.size).toBe(CELL_COUNT);
  });

  it('takes the pitch from the layer, the instrument from the row and the width from the column', () => {
    const at = (layer: number, row: number, column: number) => cellSound(toCell({ layer, row, column }));
    for (const position of [1, 2, 3]) {
      expect(at(position, 2, 1).frequency).toBeGreaterThan(at(position - 1, 2, 1).frequency);
      expect(at(1, position, 1).instrument).not.toBe(at(1, position - 1, 1).instrument);
      expect(at(1, 2, position).pan).toBeGreaterThan(at(1, 2, position - 1).pan);
    }
    // Each part depends on its own coordinate only.
    expect(at(3, 0, 0).instrument).toBe(at(0, 0, 0).instrument);
    expect(at(2, 3, 1).frequency).toBe(at(2, 0, 3).frequency);
    expect(new Set([0, 1, 2, 3].map((column) => at(0, 0, column).intervals.join()))).toHaveProperty('size', 4);
  });
});

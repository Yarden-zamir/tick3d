import { describe, expect, it } from 'vitest';
import { toCell, toCoords } from '../game.ts';
import { cellSound } from '../sound.ts';
import { cellOf, noteName } from './mapping.ts';

const semitones = (frequency: number, steps: number) => frequency * 2 ** (steps / 12);

describe('frequency to cell', () => {
  it('lights the layer of each game note: C, D, E and G', () => {
    for (const layer of [0, 1, 2, 3]) {
      const { frequency } = cellSound(toCell({ layer, row: 0, column: 0 }));
      expect(toCoords(cellOf(frequency)).layer).toBe(layer);
      // An octave up or down keeps the layer.
      expect(toCoords(cellOf(frequency * 2)).layer).toBe(layer);
      expect(toCoords(cellOf(frequency / 2)).layer).toBe(layer);
    }
  });

  it('maps every other pitch class to the nearest of C, D, E and G', () => {
    const C5 = 523.25;
    // Semitones above C, a little sharp: C# and D# lean up, F to E, F# and A to G, A# and B to the next C.
    const expected: Record<number, number> = { 1: 1, 3: 2, 5: 2, 6: 3, 8: 3, 9: 3, 10: 0, 11: 0 };
    for (const [steps, layer] of Object.entries(expected)) {
      const coords = toCoords(cellOf(semitones(C5, Number(steps) + 0.1)));
      expect(coords.layer, `${steps} semitones above C`).toBe(layer);
    }
  });

  it('moves right along the columns, then to the next layer, on a slide up', () => {
    const cells: number[] = [];
    for (let steps = -2.4; steps < 9.5; steps += 0.05) cells.push(cellOf(semitones(523.25, steps)));
    const path = cells.filter((cell, index) => cell !== cells[index - 1]).map(toCoords);
    expect(path.map(({ layer, column }) => layer * 4 + column)).toEqual([...Array(16).keys()]);
    // The whole slide stays in one row.
    expect(new Set(path.map(({ row }) => row)).size).toBe(1);
  });

  it('puts higher octaves on higher rows: a whistle on top, a hum at the bottom', () => {
    const rows = [1100, 600, 300, 150, 60].map((frequency) => toCoords(cellOf(frequency)).row);
    expect(rows).toEqual([0, 1, 2, 3, 3]);
    expect(toCoords(cellOf(3000)).row).toBe(0);
  });

  it('names the nearest note with its offset', () => {
    expect(noteName(440)).toBe('A4 +0¢');
    expect(noteName(semitones(523.25, -0.2))).toBe('C5 −20¢');
  });

  it('refuses a frequency that is not positive', () => {
    expect(() => cellOf(0)).toThrow(RangeError);
    expect(() => cellOf(Number.NaN)).toThrow(RangeError);
  });
});

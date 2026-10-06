import { describe, expect, it } from 'vitest';
import { toCell, toCoords } from '../game.ts';
import { SOUND_SETS } from '../sound-sets.ts';
import { cellOf, noteName } from './mapping.ts';

const semitones = (frequency: number, steps: number) => frequency * 2 ** (steps / 12);
const coordsOf = (frequency: number, range: { low: number; high: number } | null = null) => toCoords(cellOf(frequency, range));

// The note of a layer in the game: the Classic set plays one note for each layer.
function layerNote(layer: number): number {
  const voice = SOUND_SETS.classic.voices(toCell({ layer, row: 0, column: 0 }), 'X')[0];
  if (voice === undefined || !('frequency' in voice)) throw new Error('the Classic set plays no note');
  return voice.frequency;
}

describe('frequency to cell, default bands', () => {
  it('lights the layer of each game note: C, D, E and G', () => {
    for (const layer of [0, 1, 2, 3]) {
      const frequency = layerNote(layer);
      expect(coordsOf(frequency).layer).toBe(layer);
      // An octave up or down keeps the layer.
      expect(coordsOf(frequency * 2).layer).toBe(layer);
      expect(coordsOf(frequency / 2).layer).toBe(layer);
    }
  });

  it('maps every other pitch class to the nearest of C, D, E and G', () => {
    const C5 = 523.25;
    // Semitones above C, a little sharp: C# and D# lean up, F to E, F# and A to G, A# and B to the next C.
    const expected: Record<number, number> = { 1: 1, 3: 2, 5: 2, 6: 3, 8: 3, 9: 3, 10: 0, 11: 0 };
    for (const [steps, layer] of Object.entries(expected)) {
      expect(coordsOf(semitones(C5, Number(steps) + 0.1)).layer, `${steps} semitones above C`).toBe(layer);
    }
  });

  it('moves right along the columns, then to the next layer, on a slide up', () => {
    const cells: number[] = [];
    for (let steps = -2.4; steps < 9.5; steps += 0.05) cells.push(cellOf(semitones(523.25, steps), null));
    const path = cells.filter((cell, index) => cell !== cells[index - 1]).map(toCoords);
    expect(path.map(({ layer, column }) => layer * 4 + column)).toEqual([...Array(16).keys()]);
    // The whole slide stays in one row.
    expect(new Set(path.map(({ row }) => row)).size).toBe(1);
  });

  it('puts higher octaves on higher rows: a whistle on top, a hum at the bottom', () => {
    const rows = [1100, 600, 300, 150, 60].map((frequency) => coordsOf(frequency).row);
    expect(rows).toEqual([0, 1, 2, 3, 3]);
    expect(coordsOf(3000).row).toBe(0);
  });
});

describe('frequency to cell, calibrated range', () => {
  const range = { low: 200, high: 1600 };
  // The range is 3 octaves, so each row is 3/4 of an octave.
  const edge = (row: number) => range.low * 2 ** ((3 * row) / 4);

  it('splits the range into four rows of equal log steps, the highest row on top', () => {
    for (const fromBottom of [0, 1, 2, 3]) {
      expect(coordsOf(edge(fromBottom) * 1.001, range).row, `row band ${fromBottom} from the bottom`).toBe(3 - fromBottom);
      expect(coordsOf(edge(fromBottom + 1) * 0.999, range).row).toBe(3 - fromBottom);
    }
  });

  it('sweeps all 16 cells of a row on a slide across the row band', () => {
    const cells: number[] = [];
    for (let share = 0; share < 1; share += 0.002) cells.push(cellOf(edge(1) * (edge(2) / edge(1)) ** share, range));
    const path = cells.filter((cell, index) => cell !== cells[index - 1]).map(toCoords);
    expect(path.map(({ layer, column }) => layer * 4 + column)).toEqual([...Array(16).keys()]);
    expect(new Set(path.map(({ row }) => row))).toEqual(new Set([2]));
  });

  it('clamps a pitch outside the range to the edge cells', () => {
    expect(cellOf(50, range)).toBe(cellOf(range.low, range));
    expect(coordsOf(50, range)).toEqual({ layer: 0, row: 3, column: 0 });
    expect(coordsOf(5000, range)).toEqual({ layer: 3, row: 0, column: 3 });
    expect(coordsOf(range.high, range)).toEqual({ layer: 3, row: 0, column: 3 });
  });

  it('refuses a range that is not one', () => {
    expect(() => cellOf(300, { low: 400, high: 400 })).toThrow(RangeError);
  });
});

describe('note names', () => {
  it('names the nearest note with its offset', () => {
    expect(noteName(440)).toBe('A4 +0¢');
    expect(noteName(semitones(523.25, -0.2))).toBe('C5 −20¢');
  });

  it('refuses a frequency that is not positive', () => {
    expect(() => cellOf(0, null)).toThrow(RangeError);
    expect(() => cellOf(Number.NaN, { low: 100, high: 200 })).toThrow(RangeError);
  });
});

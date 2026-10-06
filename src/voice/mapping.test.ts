import { describe, expect, it } from 'vitest';
import { toCoords } from '../game.ts';
import { DEFAULT_RANGE, STEPS, cellOf, cellOfStep, frequencyAt, noteName, positionOf, stepOfCell } from './mapping.ts';

const semitones = (frequency: number, steps: number) => frequency * 2 ** (steps / 12);
const coordsOf = (frequency: number, range = DEFAULT_RANGE) => toCoords(cellOf(frequency, range));

describe('frequency to cell', () => {
  const range = { low: 200, high: 1600 };
  // The range is 3 octaves, so each row is 3/4 of an octave.
  const edge = (row: number) => range.low * 2 ** ((3 * row) / 4);

  it('splits the range into four rows of equal log steps, the highest row on top', () => {
    for (const fromBottom of [0, 1, 2, 3]) {
      expect(coordsOf(edge(fromBottom) * 1.001, range).row, `row band ${fromBottom} from the bottom`).toBe(3 - fromBottom);
      expect(coordsOf(edge(fromBottom + 1) * 0.999, range).row).toBe(3 - fromBottom);
    }
  });

  it('sweeps all 16 cells of a row, layer 1 column 1 to layer 4 column 4, on a slide across the row band', () => {
    const cells: number[] = [];
    for (let share = 0; share < 1; share += 0.002) cells.push(cellOf(edge(1) * (edge(2) / edge(1)) ** share, range));
    const path = cells.filter((cell, index) => cell !== cells[index - 1]).map(toCoords);
    expect(path.map(({ layer, column }) => layer * 4 + column)).toEqual([...Array(16).keys()]);
    expect(new Set(path.map(({ row }) => row))).toEqual(new Set([2]));
  });

  it('takes the nearest edge for a pitch outside the range', () => {
    expect(coordsOf(50, range)).toEqual({ layer: 0, row: 3, column: 0 });
    expect(coordsOf(5000, range)).toEqual({ layer: 3, row: 0, column: 3 });
    expect(coordsOf(range.high, range)).toEqual({ layer: 3, row: 0, column: 3 });
    expect(positionOf(range.high, range)).toBeLessThan(STEPS);
  });

  it('gives each row one octave in the default range: a hum low, a whistle high', () => {
    expect([200, 400, 800, 1600].map((frequency) => coordsOf(frequency).row)).toEqual([3, 2, 1, 0]);
    // One octave holds 16 cells, so one cell is 3/4 of a semitone.
    expect(Math.floor(positionOf(semitones(300, 0.76), DEFAULT_RANGE)) - Math.floor(positionOf(300 * 1.0001, DEFAULT_RANGE))).toBe(1);
  });

  it('turns steps and cells back and forth, and places frequencies back on their steps', () => {
    for (let step = 0; step < STEPS; step++) {
      expect(stepOfCell(cellOfStep(step))).toBe(step);
      expect(Math.floor(positionOf(frequencyAt(step + 0.5, range), range))).toBe(step);
    }
    expect(new Set(Array.from({ length: STEPS }, (_, step) => cellOfStep(step))).size).toBe(STEPS);
    expect(() => cellOfStep(64)).toThrow(RangeError);
    expect(() => cellOfStep(1.5)).toThrow(RangeError);
  });

  it('refuses a frequency or a range that is not one', () => {
    expect(() => cellOf(0, range)).toThrow(RangeError);
    expect(() => cellOf(Number.NaN, range)).toThrow(RangeError);
    expect(() => cellOf(300, { low: 400, high: 400 })).toThrow(RangeError);
  });
});

describe('note names', () => {
  it('names the nearest note with its offset', () => {
    expect(noteName(440)).toBe('A4 +0¢');
    expect(noteName(semitones(523.25, -0.2))).toBe('C5 −20¢');
  });
});

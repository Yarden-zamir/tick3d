import { describe, expect, it } from 'vitest';
import { toCoords } from '../game.ts';
import { DEFAULT_RANGE, type Range, SPREADS, STEPS, type Spread, cellOf, cellOfStep, frequencyAt, noteName, positionOf, stepOfCell } from './mapping.ts';

const log = (range: Range) => ({ range, spread: 'log' as Spread });

const semitones = (frequency: number, steps: number) => frequency * 2 ** (steps / 12);
const coordsOf = (frequency: number, range = DEFAULT_RANGE) => toCoords(cellOf(frequency, log(range)));

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
    for (let share = 0; share < 1; share += 0.002) cells.push(cellOf(edge(1) * (edge(2) / edge(1)) ** share, log(range)));
    const path = cells.filter((cell, index) => cell !== cells[index - 1]).map(toCoords);
    expect(path.map(({ layer, column }) => layer * 4 + column)).toEqual([...Array(16).keys()]);
    expect(new Set(path.map(({ row }) => row))).toEqual(new Set([2]));
  });

  it('takes the nearest edge for a pitch outside the range', () => {
    expect(coordsOf(50, range)).toEqual({ layer: 0, row: 3, column: 0 });
    expect(coordsOf(5000, range)).toEqual({ layer: 3, row: 0, column: 3 });
    expect(coordsOf(range.high, range)).toEqual({ layer: 3, row: 0, column: 3 });
    expect(positionOf(range.high, log(range))).toBeLessThan(STEPS);
  });

  it('gives each row one octave in the default range: a hum low, a whistle high', () => {
    expect([200, 400, 800, 1600].map((frequency) => coordsOf(frequency).row)).toEqual([3, 2, 1, 0]);
    // One octave holds 16 cells, so one cell is 3/4 of a semitone.
    expect(Math.floor(positionOf(semitones(300, 0.76), log(DEFAULT_RANGE))) - Math.floor(positionOf(300 * 1.0001, log(DEFAULT_RANGE)))).toBe(1);
  });

  it('turns steps and cells back and forth, and places frequencies back on their steps', () => {
    for (let step = 0; step < STEPS; step++) {
      expect(stepOfCell(cellOfStep(step))).toBe(step);
      for (const spread of SPREADS) expect(Math.floor(positionOf(frequencyAt(step + 0.5, { range, spread }), { range, spread })), `${spread} ${step}`).toBe(step);
    }
    expect(new Set(Array.from({ length: STEPS }, (_, step) => cellOfStep(step))).size).toBe(STEPS);
    expect(() => cellOfStep(64)).toThrow(RangeError);
    expect(() => cellOfStep(1.5)).toThrow(RangeError);
  });

  it('refuses a frequency or a range that is not one', () => {
    expect(() => cellOf(0, log(range))).toThrow(RangeError);
    expect(() => cellOf(Number.NaN, log(range))).toThrow(RangeError);
    expect(() => cellOf(300, log({ low: 400, high: 400 }))).toThrow(RangeError);
  });
});

describe('spreads', () => {
  const range = { low: 200, high: 1600 };
  // The width of each step in semitones.
  const widths = (spread: Spread) =>
    Array.from({ length: STEPS }, (_, step) => 12 * Math.log2(frequencyAt(step + 1, { range, spread }) / frequencyAt(step, { range, spread })));

  it('rise from the low end to the high end in every spread', () => {
    for (const spread of SPREADS) {
      const places = Array.from({ length: 200 }, (_, i) => positionOf(100 * 1.015 ** i, { range, spread }));
      expect(places.every((place, i) => i === 0 || place >= (places[i - 1] ?? 0)), spread).toBe(true);
    }
  });

  it('gives each cell the same interval in log, the same Hz in linear, and wider middle cells in middle', () => {
    const even = widths('log');
    expect(Math.max(...even) - Math.min(...even)).toBeLessThan(1e-9);
    const hz = Array.from({ length: STEPS }, (_, step) => frequencyAt(step + 1, { range, spread: 'linear' }) - frequencyAt(step, { range, spread: 'linear' }));
    expect(Math.max(...hz) - Math.min(...hz)).toBeLessThan(1e-6);
    const middle = widths('middle');
    expect(middle[32] ?? 0).toBeGreaterThan(1.4 * (middle[0] ?? 0));
    expect(middle[32] ?? 0).toBeGreaterThan(even[32] ?? 0);
  });

  it('puts the game notes C, D, E and G on the layers in the notes spread, one octave for each row', () => {
    const notes = { range: { low: 262, high: 400 }, spread: 'notes' as const };
    // C4, D4, E4 and G4: the octave of the low end is row 4.
    for (const [layer, frequency] of [261.63, 293.66, 329.63, 392].entries()) {
      expect(toCoords(cellOf(frequency, notes)), String(frequency)).toMatchObject({ layer, row: 3 });
    }
    expect(toCoords(cellOf(523.25, notes))).toMatchObject({ layer: 0, row: 2 });
    expect(toCoords(cellOf(2093, notes))).toMatchObject({ row: 0 });
    // Below the octave of the low end, and above four octaves, the edges.
    expect(cellOf(100, notes)).toBe(cellOfStep(0));
    expect(cellOf(20_000, notes)).toBe(cellOfStep(STEPS - 1));
  });
});

describe('note names', () => {
  it('names the nearest note with its offset', () => {
    expect(noteName(440)).toBe('A4 +0¢');
    expect(noteName(semitones(523.25, -0.2))).toBe('C5 −20¢');
  });
});

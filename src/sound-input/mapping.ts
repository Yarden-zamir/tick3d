// Frequency to cell. One model for every range: the range runs from `low` to `high` Hz on the log scale
// (equal musical steps), and it holds 64 steps, one for each cell.
// - The four rows split the range in equal parts. The highest part is row 1, on top.
// - Inside a row, 16 steps go from layer 1, column 1 to layer 4, column 4. So a slide up sweeps a row.
// - A pitch outside the range takes the nearest edge.
// The default range is a preset that a hum and a whistle both reach. A calibration moves its edges.
import { CELL_COUNT, toCell, toCoords } from '../game.ts';

export type Range = { low: number; high: number };

// Four octaves, one octave for each row: row 4 is a low hum (150 to 300 Hz), row 3 a high hum or a song,
// rows 2 and 1 a whistle (600 to 2400 Hz).
export const DEFAULT_RANGE: Range = { low: 150, high: 2400 };
export const STEPS = CELL_COUNT;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function checkFrequency(frequency: number): void {
  if (!(frequency > 0) || !Number.isFinite(frequency)) throw new RangeError(`not a frequency: ${frequency}`);
}

function checkRange({ low, high }: Range): void {
  if (!(low > 0 && high > low && Number.isFinite(high))) throw new RangeError(`not a range: ${low} to ${high} Hz`);
}

// The place of `frequency` in the range, from 0 (low) to just under STEPS (high). Step n is the span
// from n to n + 1. A pitch outside the range takes the nearest edge.
export function positionOf(frequency: number, range: Range): number {
  checkFrequency(frequency);
  checkRange(range);
  const share = Math.log(frequency / range.low) / Math.log(range.high / range.low);
  return Math.min(STEPS - 1e-9, Math.max(0, share * STEPS));
}

// The frequency at a place of the range: the inverse of positionOf inside the range.
export function frequencyAt(position: number, range: Range): number {
  checkRange(range);
  return range.low * (range.high / range.low) ** (position / STEPS);
}

export function cellOfStep(step: number): number {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS) throw new RangeError(`no step ${step}`);
  const inRow = step % 16;
  return toCell({ layer: Math.floor(inRow / 4), row: 3 - Math.floor(step / 16), column: inRow % 4 });
}

// The inverse of cellOfStep.
export function stepOfCell(cell: number): number {
  const { layer, row, column } = toCoords(cell);
  return (3 - row) * 16 + layer * 4 + column;
}

export const cellOf = (frequency: number, range: Range): number => cellOfStep(Math.floor(positionOf(frequency, range)));

// The nearest note name, for example "G5 +12¢".
export function noteName(frequency: number): string {
  checkFrequency(frequency);
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
  if (name === undefined) throw new RangeError(`no note name for ${nearest}`);
  return `${name}${Math.floor(nearest / 12) - 1} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

// Frequency to cell. The range runs from `low` to `high` Hz and holds 64 steps, one for each cell.
// - The four rows split the steps in equal parts. The highest part is row 1, on top.
// - Inside a row, 16 steps go from layer 1, column 1 to layer 4, column 4. So a slide up sweeps a row.
// - A pitch outside the range takes the nearest edge.
// The spread says how the 64 steps share the range (SPREADS). This file is the one place that applies it,
// so the Voice room and the game's microphone map a pitch the same way.
// The default range is a preset that a hum and a whistle both reach. A calibration moves its edges.
import { CELL_COUNT, toCell, toCoords } from '../game.ts';

export type Range = { low: number; high: number };

// log: equal musical steps (the same interval for each cell). linear: equal steps in Hz, so the low cells
// are wide and the high cells narrow. middle: wider cells in the middle of the range, where a voice is
// most at ease, and narrower ones at the edges. notes: the game's notes: the layer is the nearest of C, D,
// E and G (as the game plays the layers), the column is the place inside that note, and each row is one
// octave, from the octave of the low end up. The high end does not count then.
export const SPREADS = ['log', 'linear', 'middle', 'notes'] as const;
export type Spread = (typeof SPREADS)[number];

// The range and the spread together: everything that places a pitch.
export type PitchMap = { range: Range; spread: Spread };

// Four octaves, one octave for each row: row 4 is a low hum (150 to 300 Hz), row 3 a high hum or a song,
// rows 2 and 1 a whistle (600 to 2400 Hz).
export const DEFAULT_RANGE: Range = { low: 150, high: 2400 };
export const STEPS = CELL_COUNT;

// The share of the width of a middle cell above an even cell (and below it at the edges).
const MIDDLE_BULGE = 0.5;
// The notes spread: semitones above C after a shift of 2.5, so that the band of C (A# + 0.5 to C# ) starts
// at 0. C owns 0 to 3.5, D 3.5 to 5.5, E 5.5 to 8, and G 8 to 12.
const NOTE_SHIFT = 2.5;
const NOTE_BANDS = [0, 3.5, 5.5, 8, 12] as const;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function checkFrequency(frequency: number): void {
  if (!(frequency > 0) || !Number.isFinite(frequency)) throw new RangeError(`not a frequency: ${frequency}`);
}

function checkRange({ low, high }: Range): void {
  if (!(low > 0 && high > low && Number.isFinite(high))) throw new RangeError(`not a range: ${low} to ${high} Hz`);
}

const midiOf = (frequency: number) => 69 + 12 * Math.log2(frequency / 440);
const frequencyOfMidi = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// The middle spread as a curve from the place p (0 to 1) to the share of the log range (0 to 1). Its slope
// is 1 + MIDDLE_BULGE in the middle and 1 - MIDDLE_BULGE at the edges, and it only rises.
const middleShare = (p: number) => p - (MIDDLE_BULGE * Math.sin(2 * Math.PI * p)) / (2 * Math.PI);

// The inverse of middleShare, by bisection: 40 halvings are far below one step.
function middlePlace(share: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (middleShare(mid) < share) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// The notes spread: the shifted MIDI note where row 4 starts (the band of C in the octave of the low end).
const notesBase = (range: Range) => 12 * Math.floor((midiOf(range.low) + NOTE_SHIFT) / 12);

// The place of `frequency` in the range, from 0 (low) to just under STEPS (high). Step n is the span
// from n to n + 1. A pitch outside the range takes the nearest edge.
export function positionOf(frequency: number, { range, spread }: PitchMap): number {
  checkFrequency(frequency);
  checkRange(range);
  let share: number;
  switch (spread) {
    case 'log':
      share = Math.log(frequency / range.low) / Math.log(range.high / range.low);
      break;
    case 'linear':
      share = (frequency - range.low) / (range.high - range.low);
      break;
    case 'middle':
      share = middlePlace(clamp(Math.log(frequency / range.low) / Math.log(range.high / range.low), 0, 1));
      break;
    case 'notes': {
      const shifted = midiOf(frequency) + NOTE_SHIFT - notesBase(range);
      const octave = Math.floor(shifted / 12);
      if (octave < 0) return 0;
      if (octave > 3) return STEPS - 1e-9;
      const inOctave = shifted - 12 * octave;
      const layer = NOTE_BANDS.findIndex((edge, index) => index > 0 && inOctave < edge) - 1;
      const from = NOTE_BANDS[layer];
      const to = NOTE_BANDS[layer + 1];
      if (layer < 0 || from === undefined || to === undefined) throw new RangeError(`no note band for ${inOctave}`);
      share = (octave * 16 + layer * 4 + (4 * (inOctave - from)) / (to - from)) / STEPS;
      break;
    }
  }
  return Math.min(STEPS - 1e-9, Math.max(0, share * STEPS));
}

// The frequency at a place of the range: the inverse of positionOf inside the range.
export function frequencyAt(position: number, { range, spread }: PitchMap): number {
  checkRange(range);
  const p = clamp(position / STEPS, 0, 1);
  switch (spread) {
    case 'log':
      return range.low * (range.high / range.low) ** p;
    case 'linear':
      return range.low + (range.high - range.low) * p;
    case 'middle':
      return range.low * (range.high / range.low) ** middleShare(p);
    case 'notes': {
      const steps = Math.min(STEPS - 1e-9, p * STEPS);
      const octave = Math.floor(steps / 16);
      const inRow = steps - 16 * octave;
      const layer = Math.floor(inRow / 4);
      const from = NOTE_BANDS[layer];
      const to = NOTE_BANDS[layer + 1];
      if (from === undefined || to === undefined) throw new RangeError(`no note band for step ${steps}`);
      const shifted = notesBase(range) + 12 * octave + from + ((inRow - 4 * layer) / 4) * (to - from);
      return frequencyOfMidi(shifted - NOTE_SHIFT);
    }
  }
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

export const cellOf = (frequency: number, map: PitchMap): number => cellOfStep(Math.floor(positionOf(frequency, map)));

// The nearest note name, for example "G5 +12¢".
export function noteName(frequency: number): string {
  checkFrequency(frequency);
  const midi = midiOf(frequency);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
  if (name === undefined) throw new RangeError(`no note name for ${nearest}`);
  return `${name}${Math.floor(nearest / 12) - 1} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

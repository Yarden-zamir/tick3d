// Frequency to cell. The game plays the layers as C, D, E and G (LAYER_NOTES in src/sound.ts), so the
// note of the sound picks the layer the same way:
// - the layer is the nearest of C, D, E and G. Each one owns the pitches up to halfway to its neighbours;
// - the column is the place inside that band, in four equal steps from low (1) to high (4). So a slide
//   up moves the light right along a row and on to the next layer;
// - the row is the octave of that C, D, E or G. A whistle above 905 Hz lights row 1. A hum below 226 Hz
//   lights row 4.
import { toCell } from '../game.ts';

// Semitones above C, after a shift of 2.5: C owns A# + 0.5 to C# (0 to 3.5), D owns C# to D# (3.5 to 5.5),
// E owns D# to F + 0.5 (5.5 to 8), and G owns F + 0.5 to A# + 0.5 (8 to 12).
const SHIFT = 2.5;
const BANDS = [
  { from: 0, to: 3.5 },
  { from: 3.5, to: 5.5 },
  { from: 5.5, to: 8 },
  { from: 8, to: 12 },
] as const;
// The octave of row 1 (C6, D6, E6, G6). Each lower octave is the next row.
const TOP_OCTAVE = 6;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// The MIDI note number: 69 is A4 = 440 Hz, and one semitone is 1.
function midiOf(frequency: number): number {
  if (!(frequency > 0) || !Number.isFinite(frequency)) throw new RangeError(`not a frequency: ${frequency}`);
  return 69 + 12 * Math.log2(frequency / 440);
}

export function cellOf(frequency: number): number {
  const shifted = midiOf(frequency) + SHIFT;
  // MIDI octave -1 starts at note 0, so C4 is note 60.
  const octave = Math.floor(shifted / 12) - 1;
  const inOctave = shifted - 12 * Math.floor(shifted / 12);
  const layer = BANDS.findIndex((band) => inOctave < band.to);
  const band = BANDS[layer];
  if (band === undefined) throw new RangeError(`no band for ${inOctave} semitones`);
  const column = clamp(Math.floor((4 * (inOctave - band.from)) / (band.to - band.from)), 0, 3);
  const row = clamp(TOP_OCTAVE - octave, 0, 3);
  return toCell({ layer, row, column });
}

// The nearest note name, for example "G5 +12¢".
export function noteName(frequency: number): string {
  const midi = midiOf(frequency);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
  if (name === undefined) throw new RangeError(`no note name for ${nearest}`);
  return `${name}${Math.floor(nearest / 12) - 1} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

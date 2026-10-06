// The sound sets. Each set turns a cell and a player into a short list of voices, as plain data.
// src/sound.ts plays the voices with Web Audio, so all sets share one synthesizer.
import { type Coords, type Player, toCoords } from './game.ts';

type Filter = { type: BiquadFilterType; frequency: number; to?: number; time?: number; q?: number };
// The envelope: a ramp to `level` in `attack` seconds, then a fall to silence at `decay`, both from `at`.
// The levels are absolute for a move. The softer preview scales them down.
type Shape = { at?: number; attack?: number; decay: number; level: number; pan?: number; filter?: Filter };
type Pitched = Shape & {
  wave: OscillatorType;
  frequency: number;
  // A glide to `slideTo` that ends `slideTime` seconds after the start (the default is the decay).
  slideTo?: number;
  slideTime?: number;
  // A vibrato: `depth` is a share of the frequency.
  vibrato?: { rate: number; depth: number };
};
export type Voice = Pitched | (Shape & { wave: 'noise' });

type Four<T> = readonly [T, T, T, T];
// What one coordinate of a cell changes in the sound, and the word for each of its four values.
type Part = { hint: string; names: Four<string> };
type Dimension = keyof Coords;

export type SoundSet = {
  name: string;
  description: string;
  // The words for the parts of the sound. Classic has none: one note for each layer does not name a cell.
  parts?: Record<Dimension, Part>;
  voices(cell: number, player: Player): Voice[];
};

const at4 = <T>(values: Four<T>, index: number): T => {
  const value = values[index];
  if (value === undefined) throw new RangeError(`no value ${index} of 4`);
  return value;
};

// Sine partials of one struck body: [ratio, level, decay] for each.
const partials = (frequency: number, list: readonly (readonly [number, number, number])[], shape: Partial<Pitched> = {}): Voice[] =>
  list.map(([ratio, level, decay]) => ({ wave: 'sine', ...shape, frequency: frequency * ratio, level, decay }));

const PANS: Four<number> = [-0.75, -0.25, 0.25, 0.75];
const panned = (voices: readonly Voice[], column: number): Voice[] => voices.map((voice) => ({ ...voice, pan: at4(PANS, column) }));

// ---- Classic: the first sound of the game ----
// The layer is the note: C, D, E or G. X plays a short triangle tone with a soft octave overtone, and O plays
// the tone an octave lower. The row and the column do not change the sound, so it does not name a cell.
const LAYER_NOTES: Four<number> = [523.25, 587.33, 659.25, 783.99]; // C5, D5, E5, G5

const classic: SoundSet = {
  name: 'Classic',
  description: 'The first sound: one note for each layer. It does not name the row or the column.',
  voices(cell, player) {
    const note = at4(LAYER_NOTES, toCoords(cell).layer);
    return [
      { wave: 'triangle', frequency: player === 'X' ? note : note / 2, attack: 0.01, decay: 0.18, level: 0.25 },
      { wave: 'sine', frequency: note * 2, at: 0.02, attack: 0.01, decay: 0.08, level: 0.06 },
    ];
  },
};

// ---- Cells ----
// - the layer is the pitch: C, D, E or G of the C major pentatonic scale, higher layers higher;
// - the row is the instrument: 1 wooden marimba, 2 glass bell, 3 plucked string, 4 airy whistle;
// - the column is the width: 1 one voice, 2 with a fifth, 3 with an octave, 4 with both, and on
//   headphones it also comes from the left (1) to the right (4). The width works on a mono speaker too.
// O sounds one octave below X.
const CELLS_LEVEL = 0.28;
const WIDTHS: Four<readonly number[]> = [[1], [1, 3 / 2], [1, 2], [1, 3 / 2, 2]];
const CELL_INSTRUMENTS: Four<(frequency: number, level: number) => Voice[]> = [
  // A wooden marimba: the note and its fourth harmonic, both gone fast.
  (f, level) => partials(f, [[1, level, 0.35], [4, level * 0.3, 0.08]]),
  // A glass bell: partials that are not whole multiples ring on after the strike.
  (f, level) => partials(f, [[1, level * 0.8, 0.9], [2.76, level * 0.45, 0.6], [5.4, level * 0.2, 0.3]]),
  // A plucked string: a bright sawtooth whose filter closes fast.
  (f, level) => [
    { wave: 'sawtooth', frequency: f, attack: 0.004, decay: 0.45, level: level * 0.7, filter: { type: 'lowpass', frequency: f * 8, to: f * 1.2, time: 0.3 } },
  ],
  // An airy whistle: a soft attack and a gentle vibrato.
  (f, level) => [
    { wave: 'sine', frequency: f, attack: 0.06, decay: 0.5, level: level * 0.9, vibrato: { rate: 5.5, depth: 0.006 } },
    { wave: 'triangle', frequency: f * 2, attack: 0.06, decay: 0.4, level: level * 0.08 },
  ],
];

const cells: SoundSet = {
  name: 'Cells',
  description: 'Layer = pitch (C D E G). Row = instrument: marimba, bell, string, whistle. Column = width: 1 voice, +fifth, +octave, both.',
  parts: {
    layer: { hint: 'pitch', names: ['C', 'D', 'E', 'G'] },
    row: { hint: 'instrument', names: ['marimba', 'bell', 'pluck', 'whistle'] },
    column: { hint: 'width and side', names: ['thin, left', 'fifth, mid-left', 'octave, mid-right', 'wide, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const frequency = at4(LAYER_NOTES, layer) * (player === 'X' ? 1 : 1 / 2);
    const intervals = at4(WIDTHS, column);
    // More voices at the same level sound louder, so each voice gets a share.
    const share = CELLS_LEVEL / Math.sqrt(intervals.length);
    const instrument = at4(CELL_INSTRUMENTS, row);
    return panned(intervals.flatMap((interval) => instrument(frequency * interval, share)), column);
  },
};

// ---- Chiptune: an 8-bit game console ----
// - the layer is the note: A, C, D or E of the A minor pentatonic scale;
// - the row is the move of the first note, as in old games: 1 blip, 2 jump (a slide up), 3 drop (a slide down),
//   4 warble (a fast vibrato). Every first note lands on the layer note;
// - the column is the arpeggio: 1 one note, 2 two notes, 3 three notes, 4 four notes, 45 ms apart, and the side.
// X plays the square wave of the pulse channel. O plays the triangle wave of the bass channel, an octave lower.
const CHIP_NOTES: Four<number> = [440, 523.25, 587.33, 659.25]; // A4, C5, D5, E5
const CHIP_STEPS: Four<number> = [1, 5 / 4, 3 / 2, 2];
const CHIP_STEP = 0.045;
const CHIP_MOVES: Four<Partial<Pitched>> = [
  {},
  { slideTime: 0.07 },
  { slideTime: 0.07 },
  { vibrato: { rate: 16, depth: 0.04 } },
];
const CHIP_STARTS: Four<number> = [1, 3 / 4, 4 / 3, 1];

const chiptune: SoundSet = {
  name: 'Chiptune',
  description: 'Layer = note (A C D E). Row = move: blip, jump up, drop down, warble. Column = arpeggio of 1 to 4 notes.',
  parts: {
    layer: { hint: 'note', names: ['A', 'C', 'D', 'E'] },
    row: { hint: 'move', names: ['blip', 'jump', 'drop', 'warble'] },
    column: { hint: 'arpeggio and side', names: ['1 note, left', '2 notes, mid-left', '3 notes, mid-right', '4 notes, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const note = at4(CHIP_NOTES, layer) * (player === 'X' ? 1 : 1 / 2);
    const wave: OscillatorType = player === 'X' ? 'square' : 'triangle';
    // The triangle wave sounds much softer than the square wave at the same level.
    const level = player === 'X' ? 0.07 : 0.2;
    const count = column + 1;
    const last = count - 1;
    const steps = CHIP_STEPS.slice(0, count).map((step, index): Voice => {
      const frequency = note * step;
      const decay = index === last ? 0.2 : CHIP_STEP + 0.02;
      if (index > 0) return { wave, frequency, at: index * CHIP_STEP, attack: 0.003, decay, level };
      const start = at4(CHIP_STARTS, row);
      const slide = start === 1 ? {} : { slideTo: frequency };
      return { wave, ...at4(CHIP_MOVES, row), ...slide, frequency: frequency * start, attack: 0.003, decay: Math.max(decay, 0.1), level };
    });
    return panned(steps, column);
  },
};

export const SOUND_SETS = { classic, cells, chiptune } as const satisfies Record<string, SoundSet>;
export type SoundSetId = keyof typeof SOUND_SETS;
export const SOUND_SET_IDS = Object.keys(SOUND_SETS) as SoundSetId[];

// The groups of the sound set menu, in menu order. Every set is in exactly one group.
export const SOUND_SET_GROUPS: Record<string, readonly SoundSetId[]> = {
  'Like Cells': ['cells'],
  'New ideas': ['chiptune'],
  Classic: ['classic'],
};

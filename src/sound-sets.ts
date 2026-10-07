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
  // False keeps a cell typed on the keypad quiet until Place: the third number plays a click, and the
  // speaker plays only the last move. Every other set plays the typed cell.
  keypadPreview?: false;
  voices(cell: number, player: Player): Voice[];
};

const at4 = <T>(values: Four<T>, index: number): T => {
  const value = values[index];
  if (value === undefined) throw new RangeError(`no value ${index} of 4`);
  return value;
};

// The same voices, later and softer: an echo or a repeat.
const shifted = (voices: readonly Voice[], delay: number, gain = 1): Voice[] =>
  voices.map((voice) => ({ ...voice, at: (voice.at ?? 0) + delay, level: voice.level * gain }));

// Sine partials of one struck body: [ratio, level, decay] for each.
const partials = (frequency: number, list: readonly (readonly [number, number, number])[], shape: Partial<Pitched> = {}): Voice[] =>
  list.map(([ratio, level, decay]) => ({ wave: 'sine', ...shape, frequency: frequency * ratio, level, decay }));

const PANS: Four<number> = [-0.75, -0.25, 0.25, 0.75];
const panned = (voices: readonly Voice[], column: number): Voice[] => voices.map((voice) => ({ ...voice, pan: at4(PANS, column) }));

// ---- Classic: the first sound of the game ----
// The layer is the note: C, D, E or G. X plays a short triangle tone with a soft octave overtone, and O plays
// the tone an octave lower. The row and the column do not change the sound, so it does not name a cell.
const LAYER_NOTES: Four<number> = [523.25, 587.33, 659.25, 783.99]; // C5, D5, E5, G5

// The Classic tone at `note`. The overtone stays at the X pitch for O too, so a low O tone stays audible.
const classicTone = (note: number, player: Player): Voice[] => [
  { wave: 'triangle', frequency: player === 'X' ? note : note / 2, attack: 0.01, decay: 0.18, level: 0.25 },
  { wave: 'sine', frequency: note * 2, at: 0.02, attack: 0.01, decay: 0.08, level: 0.06 },
];

const classic: SoundSet = {
  name: 'Classic',
  description: 'The first sound: one note for each layer. It does not name the row or the column.',
  keypadPreview: false,
  voices: (cell, player) => classicTone(at4(LAYER_NOTES, toCoords(cell).layer), player),
};

// ---- Classic, pitched: the first sound, with a pitch for every cell ----
// The same tone as Classic, and the layer keeps its Classic note (C, D, E or G). The row moves the note by
// octaves: row 1 one octave up, row 2 as Classic, row 3 one octave down, row 4 two octaves down. The column
// comes from the side on headphones, left (1) to right (4). A mono speaker plays the four columns of a row
// alike, because more pitch steps would make the tone shrill or muddy.
const ROW_OCTAVES: Four<number> = [2, 1, 1 / 2, 1 / 4];

const pitched: SoundSet = {
  name: 'Classic, pitched',
  description: 'The first sound, with a pitch for each cell: the note is the layer, the octave the row, the side the column.',
  parts: {
    layer: { hint: 'note', names: ['C', 'D', 'E', 'G'] },
    row: { hint: 'octave', names: ['highest', 'high', 'low', 'lowest'] },
    column: { hint: 'side, on headphones', names: ['left', 'mid-left', 'mid-right', 'right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    return panned(classicTone(at4(LAYER_NOTES, layer) * at4(ROW_OCTAVES, row), player), column);
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

type Instrument = (frequency: number, level: number) => Voice[];

// A set with the Cells mapping and its own four instruments, one for each row.
// `level` balances the loudness of the instruments against the other sets.
function cellsFamily(name: string, description: string, instruments: Four<Instrument>, names: Four<string>, level = CELLS_LEVEL): SoundSet {
  return {
    name,
    description,
    parts: {
      layer: { hint: 'pitch', names: ['C', 'D', 'E', 'G'] },
      row: { hint: 'instrument', names },
      column: { hint: 'width and side', names: ['thin, left', 'fifth, mid-left', 'octave, mid-right', 'wide, right'] },
    },
    voices(cell, player) {
      const { layer, row, column } = toCoords(cell);
      const frequency = at4(LAYER_NOTES, layer) * (player === 'X' ? 1 : 1 / 2);
      const intervals = at4(WIDTHS, column);
      // More voices at the same level sound louder, so each voice gets a share.
      const share = level / Math.sqrt(intervals.length);
      const instrument = at4(instruments, row);
      return panned(intervals.flatMap((interval) => instrument(frequency * interval, share)), column);
    },
  };
}

const cells = cellsFamily(
  'Cells',
  'Layer = pitch (C D E G). Row = marimba, bell, string, whistle. Column = width: 1 voice, +fifth, +octave, both. O is an octave lower.',
  CELL_INSTRUMENTS,
  ['marimba', 'bell', 'pluck', 'whistle'],
);

// Soft: mellow instruments with no sharp attack.
const soft = cellsFamily(
  'Soft',
  'Mellow, no sharp attacks. Rows: flute, clarinet, felt piano, vibraphone. The rest as in Cells.',
  [
    // A flute: a pure tone with a slow vibrato and a breath of noise at the start.
    (f, level) => [
      { wave: 'sine', frequency: f, attack: 0.05, decay: 0.5, level: level * 0.85, vibrato: { rate: 5, depth: 0.005 } },
      { wave: 'sine', frequency: f * 2, attack: 0.05, decay: 0.4, level: level * 0.12 },
      { wave: 'noise', attack: 0.03, decay: 0.15, level: level * 0.12, filter: { type: 'bandpass', frequency: f * 2, q: 3 } },
    ],
    // A clarinet: the odd harmonics of a square wave, through a dark filter.
    (f, level) => [{ wave: 'square', frequency: f, attack: 0.04, decay: 0.5, level: level * 0.5, filter: { type: 'lowpass', frequency: f * 3, q: 0.7 } }],
    // A felt piano: a soft hammer, few harmonics, a short ring.
    (f, level) => partials(f, [[1, level * 0.85, 0.55], [2, level * 0.22, 0.3], [3, level * 0.06, 0.15]], { attack: 0.012 }),
    // A vibraphone: two bars a few hertz apart beat like the vibraphone motor, plus the fourth partial of a bar.
    (f, level) => [
      ...partials(f, [[1, level * 0.45, 0.6]], { attack: 0.006 }),
      ...partials(f + 5.5, [[1, level * 0.45, 0.6], [4, level * 0.1, 0.12]], { attack: 0.006 }),
    ],
  ],
  ['flute', 'clarinet', 'felt piano', 'vibraphone'],
);

// Orchestra: strings, harp, brass and celesta.
const orchestra = cellsFamily(
  'Orchestra',
  'Rows: pizzicato strings, harp, French horn, celesta. The rest as in Cells.',
  [
    // Pizzicato: a plucked bowed string, a short body and an edge that goes fast.
    (f, level) => [
      { wave: 'sawtooth', frequency: f, attack: 0.003, decay: 0.3, level: level * 0.55, filter: { type: 'lowpass', frequency: f * 5, to: f * 1.5, time: 0.15 } },
      { wave: 'sine', frequency: f, attack: 0.003, decay: 0.25, level: level * 0.3 },
    ],
    // A harp: a round pluck with a long, gentle ring.
    (f, level) => [
      { wave: 'triangle', frequency: f, attack: 0.004, decay: 0.6, level: level * 0.65 },
      ...partials(f, [[2, level * 0.2, 0.35], [3, level * 0.07, 0.2]], { attack: 0.004 }),
    ],
    // A French horn: a soft swell whose filter opens, like brass, with a little vibrato.
    (f, level) => [
      { wave: 'sawtooth', frequency: f, attack: 0.07, decay: 0.55, level: level * 0.5, vibrato: { rate: 4.5, depth: 0.003 }, filter: { type: 'lowpass', frequency: f * 1.5, to: f * 3, time: 0.12, q: 1 } },
    ],
    // A celesta: small steel bars an octave up, sweet and bright.
    (f, level) => partials(f * 2, [[1, level * 0.6, 0.5], [3, level * 0.06, 0.08]], { attack: 0.003 }),
  ],
  ['pizzicato', 'harp', 'horn', 'celesta'],
  0.38,
);

// Lo-fi keys: warm keyboard sounds with a slow wobble, like an old tape.
const lofi = cellsFamily(
  'Lo-fi keys',
  'Warm and wobbly. Rows: electric piano, pad pluck, upright bass, music box. The rest as in Cells.',
  [
    // A Rhodes-style electric piano: two tines 3 Hz apart wobble, and a bell partial gives the bark.
    (f, level) => [
      ...partials(f, [[1, level * 0.4, 0.55]], { attack: 0.006 }),
      ...partials(f + 3, [[1, level * 0.4, 0.55]], { attack: 0.006 }),
      ...partials(f, [[7, level * 0.06, 0.07]], { attack: 0.003 }),
    ],
    // A warm pad pluck: two detuned sawtooth waves, the filter closes slowly.
    (f, level) =>
      [1, 1.006].map((detune): Voice => ({
        wave: 'sawtooth',
        frequency: f * detune,
        attack: 0.02,
        decay: 0.55,
        level: level * 0.3,
        filter: { type: 'lowpass', frequency: f * 4, to: f * 1.3, time: 0.45 },
      })),
    // A soft upright bass: a round thump, at the pitch of the layer.
    (f, level) => [
      { wave: 'triangle', frequency: f, attack: 0.008, decay: 0.45, level: level * 0.8, filter: { type: 'lowpass', frequency: f * 2.5, to: f * 1.2, time: 0.3 } },
      { wave: 'sine', frequency: f / 2, attack: 0.008, decay: 0.3, level: level * 0.2 },
    ],
    // A music box: a thin steel tine with a slow tape wobble.
    (f, level) => [
      { wave: 'sine', frequency: f, attack: 0.002, decay: 0.55, level: level * 0.6, vibrato: { rate: 0.8, depth: 0.004 } },
      { wave: 'sine', frequency: f * 4.1, attack: 0.002, decay: 0.07, level: level * 0.15 },
    ],
  ],
  ['electric piano', 'pad pluck', 'upright bass', 'music box'],
  0.32,
);

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
    const level = player === 'X' ? 0.13 : 0.38;
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

// ---- Gamelan: a Javanese bronze orchestra ----
// - the layer is the note: four steps of the slendro scale, about 240 cents apart;
// - the row is the instrument: 1 saron (a thick bar), 2 bonang (a small kettle gong), 3 gender (a thin bar over
//   a tube, soft mallet), 4 kempul (a hanging gong whose pitch sinks);
// - the column is the ombak, the "wave": a gamelan tunes each pair of instruments a few hertz apart, and the
//   pair beats. 1 no partner (still), 2 a slow wave of 3 Hz, 3 a wave of 7 Hz, 4 a fast shimmer of 12 Hz. And the side.
// X plays the instrument. O plays its low brother (demung, kenong), an octave lower.
// 240 cents is a fifth of an octave.
const SLENDRO: Four<number> = [392, 392 * 2 ** 0.2, 392 * 2 ** 0.4, 392 * 2 ** 0.6];
const OMBAK: Four<number> = [0, 3, 7, 12];
const GAMELAN: Four<(f: number) => Voice[]> = [
  (f) => partials(f, [[1, 0.2, 0.5], [2.71, 0.07, 0.25], [4.95, 0.03, 0.1]], { attack: 0.003 }),
  (f) => partials(f, [[1, 0.16, 0.55], [1.52, 0.05, 0.4], [2.31, 0.06, 0.3], [3.93, 0.03, 0.15]], { attack: 0.004, slideTo: f * 0.995 }),
  (f) => partials(f, [[1, 0.22, 0.6], [3.9, 0.025, 0.12]], { attack: 0.02 }),
  (f) => [
    ...partials(f, [[1, 0.18, 0.6], [2.08, 0.05, 0.4]], { attack: 0.008, slideTo: f * 0.965 }),
    ...partials(f / 2, [[1, 0.1, 0.6]], { attack: 0.01 }),
  ],
];

const gamelan: SoundSet = {
  name: 'Gamelan',
  description: 'Bronze from Java. Layer = slendro note. Row = saron, bonang, gender, gong. Column = the beat of the tuned pair: none, slow, fast, shimmer.',
  parts: {
    layer: { hint: 'slendro note', names: ['ji', 'ro', 'lu', 'ma'] },
    row: { hint: 'instrument', names: ['saron', 'bonang', 'gender', 'gong'] },
    column: { hint: 'beat and side', names: ['still, left', 'slow wave, mid-left', 'fast wave, mid-right', 'shimmer, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const f = at4(SLENDRO, layer) * (player === 'X' ? 1 : 1 / 2);
    const instrument = at4(GAMELAN, row);
    const beat = at4(OMBAK, column);
    const voices = beat === 0 ? instrument(f) : [...shifted(instrument(f), 0, 0.6), ...shifted(instrument(f + beat), 0, 0.6)];
    return panned(voices, column);
  },
};

// ---- Kalimba: a thumb piano in a wooden box ----
// - the layer is the note: G, A, B or D of the G major pentatonic scale;
// - the row is the tine: 1 warm thumb pluck, 2 bright steel comb, 3 buzz (a rattle ring on the tine),
//   4 wah (the hand opens the sound hole);
// - the column is the box echo: 1 dry, 2 one echo, 3 two echoes, 4 three echoes, 0.11 s apart. And the side.
// O plays the low tines, an octave below X.
const KALIMBA_NOTES: Four<number> = [783.99, 880, 987.77, 1174.66]; // G5, A5, B5, D6
const TINES: Four<(f: number) => Voice[]> = [
  (f) => partials(f, [[1, 0.3, 0.5], [6.1, 0.03, 0.04]], { attack: 0.003 }),
  (f) => partials(f, [[1, 0.2, 0.4], [2, 0.08, 0.2], [4.2, 0.05, 0.08]], { attack: 0.002 }),
  (f) => [
    ...partials(f, [[1, 0.25, 0.45]], { attack: 0.003 }),
    { wave: 'square', frequency: f, attack: 0.003, decay: 0.2, level: 0.04, filter: { type: 'bandpass', frequency: f * 3, q: 4 } },
  ],
  (f) => [{ wave: 'triangle', frequency: f, attack: 0.004, decay: 0.45, level: 0.35, filter: { type: 'lowpass', frequency: f * 1.1, to: f * 5, time: 0.25, q: 6 } }],
];
const ECHO_GAP = 0.11;

const kalimba: SoundSet = {
  name: 'Kalimba',
  description: 'A thumb piano. Layer = note (G A B D). Row = tine: warm, steel, buzz, wah. Column = box echoes: 0, 1, 2, 3.',
  parts: {
    layer: { hint: 'note', names: ['G', 'A', 'B', 'D'] },
    row: { hint: 'tine', names: ['warm', 'steel', 'buzz', 'wah'] },
    column: { hint: 'echoes and side', names: ['dry, left', '1 echo, mid-left', '2 echoes, mid-right', '3 echoes, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const f = at4(KALIMBA_NOTES, layer) * (player === 'X' ? 1 : 1 / 2);
    // An echo is short: the decay of each voice ends with the next echo or soon after.
    const pluck = at4(TINES, row)(f);
    const echo = pluck.map((voice) => ({ ...voice, decay: Math.min(voice.decay, 0.22) }));
    const echoes = [1, 2, 3].slice(0, column).flatMap((index) => shifted(echo, index * ECHO_GAP, 0.45 ** index));
    return panned(shifted([...pluck, ...echoes], 0, 0.65), column);
  },
};

// ---- Percussion: a drum kit, no melody ----
// - the layer is the drum, low to high: 1 kick, 2 tom, 3 snare, 4 woodblock;
// - the row is the tuning: 1 low, 2 a third up, 3 two thirds up, 4 an octave up;
// - the column is the stroke: 1 single hit, 2 flam (a grace note just before), 3 double hit, 4 drag (three hits).
//   And the side.
// X plays with sticks: a bright click on each hit. O plays with soft mallets: no click.
const TUNINGS: Four<number> = [1, 1.26, 1.59, 2];
const DRUMS: Four<(t: number) => Voice[]> = [
  // Kick: a sine that falls fast, and a short thump.
  (t) => [
    { wave: 'sine', frequency: 150 * t, slideTo: 50 * t, slideTime: 0.12, attack: 0.003, decay: 0.35, level: 0.5 },
    { wave: 'noise', attack: 0.002, decay: 0.04, level: 0.12, filter: { type: 'lowpass', frequency: 900 * t } },
  ],
  // Tom: a round body that sinks a little.
  (t) => [
    { wave: 'sine', frequency: 200 * t, slideTo: 150 * t, attack: 0.003, decay: 0.4, level: 0.42 },
    { wave: 'triangle', frequency: 400 * t, slideTo: 300 * t, attack: 0.003, decay: 0.12, level: 0.1 },
  ],
  // Snare: a short body and a burst of bright noise.
  (t) => [
    { wave: 'triangle', frequency: 190 * t, attack: 0.002, decay: 0.12, level: 0.2 },
    { wave: 'noise', attack: 0.002, decay: 0.22, level: 0.35, filter: { type: 'bandpass', frequency: 2400 * t, q: 0.9 } },
  ],
  // Woodblock: a hollow, very short knock.
  (t) => [
    { wave: 'sine', frequency: 800 * t, attack: 0.001, decay: 0.09, level: 0.35 },
    { wave: 'sine', frequency: 800 * t * 2.7, attack: 0.001, decay: 0.04, level: 0.08 },
  ],
];
// The hits of each stroke: [time, gain].
const STROKES: Four<readonly (readonly [number, number])[]> = [
  [[0, 1]],
  [[0, 0.45], [0.035, 1]],
  [[0, 1], [0.12, 0.8]],
  [[0, 0.5], [0.06, 0.6], [0.14, 1]],
];

const percussion: SoundSet = {
  name: 'Percussion',
  description: 'A drum kit, no melody. Layer = drum: kick, tom, snare, woodblock. Row = tuning, low to high. Column = stroke: 1 hit, flam, double, drag.',
  parts: {
    layer: { hint: 'drum', names: ['kick', 'tom', 'snare', 'woodblock'] },
    row: { hint: 'tuning', names: ['low', 'mid-low', 'mid-high', 'high'] },
    column: { hint: 'stroke and side', names: ['single, left', 'flam, mid-left', 'double, mid-right', 'drag, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const hit = at4(DRUMS, layer)(at4(TUNINGS, row));
    const stick: Voice = { wave: 'noise', attack: 0.001, decay: 0.02, level: 0.15, filter: { type: 'highpass', frequency: 5000 } };
    // A mallet is soft: it starts slower and has no click.
    const struck = player === 'X' ? [...hit, stick] : hit.map((voice) => ({ ...voice, attack: 0.012 }));
    // The hits overlap, so each one is a share of the level.
    const voices = at4(STROKES, column).flatMap(([time, gain]) => shifted(struck, time, gain * 0.68));
    return panned(voices, column);
  },
};

// ---- Choir: sung vowels ----
// - the layer is the sung note: C, D, E or G;
// - the row is the vowel, from three formant filters on a buzzing voice: 1 "ah", 2 "eh", 3 "ee", 4 "oh";
// - the column is the harmony: 1 solo, 2 with a sweet third, 3 with an open fifth, 4 the full major chord. And the side.
// X sings as a tenor. O sings as a bass, an octave lower.
const CHOIR_NOTES: Four<number> = [261.63, 293.66, 329.63, 392]; // C4, D4, E4, G4
// The formants of each vowel in hertz, after Peterson and Barney (1952), with their levels.
const VOWELS: Four<readonly (readonly [number, number])[]> = [
  [[730, 1], [1090, 0.5], [2440, 0.25]],
  [[530, 1], [1840, 0.45], [2480, 0.25]],
  [[270, 1], [2290, 0.4], [3010, 0.25]],
  [[450, 1], [800, 0.55], [2830, 0.12]],
];
const HARMONIES: Four<readonly number[]> = [[1], [1, 5 / 4], [1, 3 / 2], [1, 5 / 4, 3 / 2]];

const choir: SoundSet = {
  name: 'Choir',
  description: 'Sung vowels. Layer = note (C D E G). Row = vowel: ah, eh, ee, oh. Column = harmony: solo, third, fifth, full chord.',
  parts: {
    layer: { hint: 'sung note', names: ['C', 'D', 'E', 'G'] },
    row: { hint: 'vowel', names: ['ah', 'eh', 'ee', 'oh'] },
    column: { hint: 'harmony and side', names: ['solo, left', 'third, mid-left', 'fifth, mid-right', 'chord, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const root = at4(CHOIR_NOTES, layer) * (player === 'X' ? 1 : 1 / 2);
    const harmony = at4(HARMONIES, column);
    const share = 1.1 / Math.sqrt(harmony.length);
    const voices = harmony.flatMap((interval) =>
      at4(VOWELS, row).map(([formant, level]): Voice => ({
        wave: 'sawtooth',
        frequency: root * interval,
        attack: 0.06,
        decay: 0.55,
        level: share * level,
        vibrato: { rate: 5, depth: 0.007 },
        filter: { type: 'bandpass', frequency: formant, q: 8 },
      })),
    );
    return panned(voices, column);
  },
};

// ---- Nature: calm sounds outside ----
// - the layer is the source, from the ground to the sky: 1 wood knock, 2 water drop, 3 cricket, 4 bird chirp;
// - the row is the size of the source: 1 small (high) to 4 large (low), a minor third apart;
// - the column is the weather around it: 1 calm, 2 a soft breeze, 3 light rain, 4 a cave echo. And the side.
// O is the night: every source sounds an octave lower.
const SIZES: Four<number> = [1.68, 1.41, 1.19, 1];
const SOURCES: Four<(f: number) => Voice[]> = [
  (f) => [
    ...partials(f * 500, [[1, 0.35, 0.07], [2.3, 0.12, 0.04]], { attack: 0.001 }),
    { wave: 'noise', attack: 0.001, decay: 0.02, level: 0.1, filter: { type: 'bandpass', frequency: f * 2000, q: 3 } },
  ],
  // A water drop: a quick rising "plip".
  (f) => [{ wave: 'sine', frequency: f * 600, slideTo: f * 1400, slideTime: 0.06, attack: 0.002, decay: 0.13, level: 0.32 }],
  // A cricket: three short high pulses.
  (f) => [0, 0.05, 0.1].map((time): Voice => ({ wave: 'sine', frequency: f * 2600, at: time, attack: 0.004, decay: 0.03, level: 0.13 })),
  // A bird: a fast sweep up with a trill, then a short fall.
  (f) => [
    { wave: 'sine', frequency: f * 1500, slideTo: f * 2600, slideTime: 0.08, attack: 0.005, decay: 0.1, level: 0.16, vibrato: { rate: 35, depth: 0.04 } },
    { wave: 'sine', frequency: f * 2400, slideTo: f * 1800, at: 0.11, attack: 0.005, decay: 0.08, level: 0.13 },
  ],
];
const WEATHER: Four<(source: readonly Voice[]) => Voice[]> = [
  () => [],
  () => [{ wave: 'noise', attack: 0.15, decay: 0.55, level: 0.12, filter: { type: 'bandpass', frequency: 500, to: 900, q: 0.8 } }],
  () => [0.04, 0.13, 0.21, 0.33, 0.42].map((time): Voice => ({ wave: 'noise', at: time, attack: 0.001, decay: 0.015, level: 0.1, filter: { type: 'highpass', frequency: 4000 } })),
  (source) => [...shifted(source, 0.16, 0.4), ...shifted(source, 0.32, 0.16)],
];

const nature: SoundSet = {
  name: 'Nature',
  description: 'Calm and abstract. Layer = wood knock, water drop, cricket, bird. Row = size, small to large. Column = weather: calm, breeze, rain, cave echo.',
  parts: {
    layer: { hint: 'source', names: ['wood', 'drop', 'cricket', 'bird'] },
    row: { hint: 'size', names: ['small', 'medium', 'big', 'large'] },
    column: { hint: 'weather and side', names: ['calm, left', 'breeze, mid-left', 'rain, mid-right', 'cave, right'] },
  },
  voices(cell, player) {
    const { layer, row, column } = toCoords(cell);
    const size = at4(SIZES, row) * (player === 'X' ? 1 : 1 / 2);
    const source = at4(SOURCES, layer)(size);
    return panned(shifted([...source, ...at4(WEATHER, column)(source)], 0, 1.6), column);
  },
};

// ---- Harmony: a music lesson ----
// Equal temperament with A4 = 440 Hz, chords of C major:
// - the layer is the register: the root sits in octave 3, 4, 5 or 6;
// - the row is the chord: I (C major), IV (F major), V (G major), vi (A minor);
// - the column is the voicing: root position, 1st inversion, 2nd inversion, and the seventh chord in root position
//   (Cmaj7, Fmaj7, G7, Am7: V7 is a dominant seventh).
// X plays a piano. O plays an organ: the same notes with another timbre, so the theory stays exact.
export const midiHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
// The pitch class of each root (C = 0), and the semitones above the root of its triad and its seventh chord.
const CHORDS: Four<{ root: number; triad: readonly [number, number, number]; seventh: readonly number[] }> = [
  { root: 0, triad: [0, 4, 7], seventh: [0, 4, 7, 11] }, // C major, Cmaj7
  { root: 5, triad: [0, 4, 7], seventh: [0, 4, 7, 11] }, // F major, Fmaj7
  { root: 7, triad: [0, 4, 7], seventh: [0, 4, 7, 10] }, // G major, G7
  { root: 9, triad: [0, 3, 7], seventh: [0, 3, 7, 10] }, // A minor, Am7
];

// The MIDI notes of a cell's chord, low to high. Middle C (C4) is 60.
export function harmonyNotes(cell: number): number[] {
  const { layer, row, column } = toCoords(cell);
  const chord = at4(CHORDS, row);
  const root = 12 * (layer + 4) + chord.root;
  const [first, third, fifth] = chord.triad;
  const steps = [chord.triad, [third, fifth, first + 12], [fifth, first + 12, third + 12], chord.seventh][column];
  if (steps === undefined) throw new RangeError(`no voicing ${column}`);
  return steps.map((step) => root + step);
}

const ROLL = 0.018;
// High notes get softer and lose their upper partials, so octave 6 stays sweet.
const brightness = (frequency: number) => Math.min(1, Math.sqrt(700 / frequency));

const harmony: SoundSet = {
  name: 'Harmony',
  description: 'Chords in C major. Layer = octave 3 to 6. Row = I, IV, V, vi (C, F, G, Am). Column = root position, 1st inversion, 2nd inversion, seventh. X piano, O organ.',
  parts: {
    layer: { hint: 'register', names: ['octave 3', 'octave 4', 'octave 5', 'octave 6'] },
    row: { hint: 'chord', names: ['I (C major)', 'IV (F major)', 'V (G major)', 'vi (A minor)'] },
    column: { hint: 'voicing', names: ['root position', '1st inversion', '2nd inversion', 'seventh (maj7, 7, m7)'] },
  },
  voices(cell, player) {
    const notes = harmonyNotes(cell);
    const level = 0.4 / notes.length;
    // A piano: a hammer strike, harmonics that fade first, and a slight roll upward. An organ: steady pipes, 8', 4' and 2'.
    const piano: readonly (readonly [number, number, number])[] = [[1, 1, 0.6], [2, 0.35, 0.3], [3, 0.12, 0.18]];
    const organ: readonly (readonly [number, number, number])[] = [[1, 0.7, 0.5], [2, 0.4, 0.5], [4, 0.15, 0.5]];
    return notes.flatMap((midi, index) => {
      const f = midiHz(midi);
      const shape = player === 'X' ? { at: index * ROLL, attack: 0.004 } : { attack: 0.03 };
      const audible = (player === 'X' ? piano : organ).filter(([ratio]) => ratio === 1 || f * ratio < 3500);
      return partials(f, audible.map(([ratio, gain, decay]) => [ratio, level * gain * brightness(f), decay] as const), shape);
    });
  },
};

export const SOUND_SETS = {
  classic,
  pitched,
  cells,
  soft,
  orchestra,
  lofi,
  gamelan,
  chiptune,
  kalimba,
  percussion,
  choir,
  nature,
  harmony,
} as const satisfies Record<string, SoundSet>;
export type SoundSetId = keyof typeof SOUND_SETS;
export const SOUND_SET_IDS = Object.keys(SOUND_SETS) as SoundSetId[];

// The groups of the sound set menu, by character, in menu order. Every set is in exactly one group.
export const SOUND_SET_GROUPS: readonly { title: string; subtitle: string; ids: readonly SoundSetId[] }[] = [
  { title: 'Instruments', subtitle: 'Same map as Cells: pitch = layer, instrument = row, width = column.', ids: ['cells', 'soft', 'orchestra', 'lofi'] },
  { title: 'World and voice', subtitle: 'Bronze, tines and voices, each with its own map.', ids: ['gamelan', 'kalimba', 'choir'] },
  { title: 'Playful', subtitle: 'Game blips, drums and nature sounds, each with its own map.', ids: ['chiptune', 'percussion', 'nature'] },
  { title: 'For musicians', subtitle: 'Real chords in C major, named as in a music lesson.', ids: ['harmony'] },
  { title: 'Original', subtitle: 'The first sound, with one note per layer or a pitch per cell.', ids: ['classic', 'pitched'] },
];

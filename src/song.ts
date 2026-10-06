// "Your game as a song": the moves of a finished game as a short piece of music, as plain data.
// The moves make each song its own: the cells give the melody, the move times give the rhythm, and a
// hash of the moves picks the key and the mode. Music theory keeps it musical:
// - every melody note is on the scale of the song. The pentatonic scales have no clashing intervals;
// - the notes sit on an eighth-note grid at a fixed tempo, over a loop of four chords, one for each bar;
// - on a strong beat, the melody takes the nearest note of the chord;
// - X and O answer each other an octave apart, and the song ends on the tonic.
// src/sound.ts plays the notes with the voices of a sound set, live or into a sound file.
import { type Game, type Player, other, toCoords } from './game.ts';

const BPM = 112;
export const EIGHTH = 60 / BPM / 2;
const BAR = 8;
// A move lasts one eighth note to one half note, from the time that the player took for the next move.
export const MIN_EIGHTHS = 1;
export const MAX_EIGHTHS = 4;
// The reverb rings on after the last chord.
const TAIL = 2;

const MODES = {
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
} as const satisfies Record<string, readonly number[]>;
type Mode = keyof typeof MODES;
// The hash picks from this list. Major pentatonic is the default mode: it has half of the places.
const MODE_PICKS: readonly Mode[] = ['major pentatonic', 'major pentatonic', 'minor pentatonic', 'dorian'];

// The chords as semitones above the tonic, one for each bar: I–V–vi–IV in major, i–VI–III–VII in minor.
const MAJOR_LOOP = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] as const;
const MINOR_LOOP = [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]] as const;

// `root` is the pitch class of the tonic: 0 is C, 11 is B.
export type Key = { root: number; mode: Mode };

export type SongNote =
  // A melody note of a player. `cell` is the cell of the move, for the timbre and the highlight. `move` is
  // the index of the move in the game, for the notes of the moves (not for the ending).
  | { kind: 'melody'; at: number; midi: number; player: Player; cell: number; level: number; move?: number }
  // A soft pad note of a chord, or the bass note under it.
  | { kind: 'chord' | 'bass'; at: number; midi: number; length: number };
export type Song = { key: Key; notes: readonly SongNote[]; duration: number };

// FNV-1a over the first player and the moves, so the same game always gets the same key.
function keyOf(game: Game): Key {
  let hash = 0x811c9dc5;
  for (const value of [game.first === 'X' ? 64 : 65, ...game.moves]) hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  const mode = MODE_PICKS[(hash >>> 4) % MODE_PICKS.length];
  if (mode === undefined) throw new Error('no mode');
  return { root: hash % 12, mode };
}

// The pitch classes of the scale of a key.
export const scaleOf = (key: Key): number[] => MODES[key.mode].map((step) => (key.root + step) % 12);

const third = (key: Key) => (key.mode === 'major pentatonic' ? 4 : 3);

// The MIDI note of scale degree `degree` above the tonic `base`. Degree 0 is the tonic.
function pitchOf(degree: number, base: number, mode: Mode): number {
  const scale: readonly number[] = MODES[mode];
  const octave = Math.floor(degree / scale.length);
  const step = scale[degree - octave * scale.length];
  if (step === undefined) throw new RangeError(`no degree ${degree}`);
  return base + 12 * octave + step;
}

// The scale degree of a cell, 0 to 9 (two octaves of a pentatonic scale): a higher layer, a higher row
// and a column further right sound higher. The same cell always gives the same degree.
function degreeOf(cell: number): number {
  const { layer, row, column } = toCoords(cell);
  return layer + (3 - row) + column;
}

// The tonic of a player's octave: X between F#3 and F4, O one octave lower.
function baseOf(key: Key, player: Player): number {
  const x = 60 + key.root - (key.root > 6 ? 12 : 0);
  return player === 'X' ? x : x - 12;
}

// The time to the next move as eighth notes: about one more eighth for each doubling of the time.
// Without times (an old record), each move is a quarter note.
export function eighthsOf(gapMs: number | undefined): number {
  if (gapMs === undefined || !(gapMs > 0)) return 2;
  return Math.min(MAX_EIGHTHS, Math.max(MIN_EIGHTHS, Math.round(Math.log2(gapMs / 1000) + 1)));
}

// A chord as pad notes from the octave of C3, and its lowest note as a bass note one octave lower.
function chord(key: Key, steps: readonly number[], at: number, length: number): SongNote[] {
  const base = 48 + key.root;
  return [
    ...steps.map((step) => ({ kind: 'chord' as const, at, midi: base + step, length })),
    { kind: 'bass', at, midi: base - 12 + ((steps[0] ?? 0) % 12), length },
  ];
}

export function songOf(game: Game): Song {
  if (game.moves.length === 0) throw new RangeError('a game without moves has no song');
  const key = keyOf(game);
  const loop = key.mode === 'major pentatonic' ? MAJOR_LOOP : MINOR_LOOP;
  const chordAt = (eighth: number) => loop[Math.floor(eighth / BAR) % loop.length] ?? loop[0];
  const notes: SongNote[] = [];

  let position = 0;
  let player = game.first;
  game.moves.forEach((cell, index) => {
    const base = baseOf(key, player);
    let degree = degreeOf(cell);
    // Beats 1 and 3 of a bar are strong: there the melody takes the nearest scale note of the chord.
    const strong = position % 4 === 0;
    if (strong) {
      const tones = chordAt(position).map((step) => (key.root + step) % 12);
      const fits = (candidate: number) => candidate >= 0 && tones.includes(pitchOf(candidate, base, key.mode) % 12);
      degree = [0, -1, 1, -2, 2].map((shift) => degree + shift).find(fits) ?? degree;
    }
    notes.push({ kind: 'melody', at: position * EIGHTH, midi: pitchOf(degree, base, key.mode), player, cell, level: strong ? 0.75 : 0.6, move: index });
    const now = game.times[index];
    const next = game.times[index + 1];
    position += eighthsOf(now === undefined || next === undefined ? undefined : next - now);
    player = other(player);
  });

  // The chord loop plays under the moves, and the ending starts on the next bar.
  const end = Math.ceil(position / BAR) * BAR;
  for (let bar = 0; bar < end; bar += BAR) notes.push(...chord(key, chordAt(bar), bar * EIGHTH, BAR * EIGHTH));
  const winner = game.status.kind === 'won' || game.status.kind === 'timeout' ? game.status.winner : null;
  let last = end;
  if (winner !== null) {
    // The winner climbs the tonic chord to the tonic one octave up, on the cells of the winning line.
    const cells = game.status.kind === 'won' ? game.status.line : [game.moves.at(-1) ?? 0];
    [0, third(key), 7, 12].forEach((step, index) => {
      const cell = cells[index % cells.length] ?? 0;
      notes.push({ kind: 'melody', at: (end + index / 2) * EIGHTH, midi: baseOf(key, winner) + step, player: winner, cell, level: 0.7 });
    });
    last = end + 2;
  } else {
    // A draw: a suspended chord, then the tonic chord with the tonic on top.
    notes.push(...chord(key, [0, 5, 7], end * EIGHTH, 4 * EIGHTH));
    last = end + 4;
    notes.push({ kind: 'melody', at: last * EIGHTH, midi: baseOf(key, game.first) + 12, player: game.first, cell: game.moves[0] ?? 0, level: 0.7 });
  }
  notes.push(...chord(key, [0, third(key), 7], last * EIGHTH, BAR * EIGHTH));
  return { key, notes, duration: (last + BAR) * EIGHTH + TAIL };
}

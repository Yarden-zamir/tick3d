// "Your game as a song": the moves of a finished game as a short, brisk piece of music, as plain data.
// The moves make each song its own: the cells give the melody, and a hash of the moves picks the key and
// the mode. The rhythm is fixed, so every song has the same even pulse:
// - each move is one eighth note at 136 BPM, or one sixteenth note in a long game. The move times do not
//   change the rhythm, so a long think leaves no gap;
// - every melody note is on the scale of the song. The pentatonic scales have no clashing intervals;
// - a loop of four chords, one for each bar. On each beat, the melody takes the nearest note of the chord,
//   and a short bass note plays the root or the fifth of the chord;
// - X and O answer each other an octave apart. The ending is short: the winner runs up the tonic chord on
//   the winning line, and one final chord ends on the tonic.
// src/sound.ts plays the notes with the voices of a sound set, live or into a sound file.
import { type Game, type Player, other, toCoords } from './game.ts';

const BPM = 136;
// The grid of the song. All times are whole sixteenth notes.
export const SIXTEENTH = 60 / BPM / 4;
const BEAT = 4;
const BAR = 4 * BEAT;
// A game with more moves than this gives each move a sixteenth note, not an eighth note. So the moves of
// the longest game (64 moves) last as long as 32 eighth notes: about 7 seconds.
const LONG_GAME = 32;
// The final chord rings this long, in seconds.
const FINAL_RING = 1;

const MODES = {
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
} as const satisfies Record<string, readonly number[]>;
type Mode = keyof typeof MODES;
// The hash picks from this list. Major pentatonic is the default mode: it has half of the places.
const MODE_PICKS: readonly Mode[] = ['major pentatonic', 'major pentatonic', 'minor pentatonic', 'dorian'];

// The chords as semitones above the tonic, one for each bar: I–V–vi–IV in major, i–VI–III–VII in minor.
// The first step of a chord is its root, and the last step is its fifth.
const MAJOR_LOOP = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] as const;
const MINOR_LOOP = [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]] as const;

// `root` is the pitch class of the tonic: 0 is C, 11 is B.
export type Key = { root: number; mode: Mode };

export type SongNote =
  // A melody note of a player. `cell` is the cell of the move, for the timbre and the highlight. `move` is
  // the index of the move in the game, for the notes of the moves (not for the ending).
  | { kind: 'melody'; at: number; midi: number; player: Player; cell: number; level: number; move?: number }
  // A note of the final chord, or a short bass note on a beat. `length` is in seconds.
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

// The bass octave: the tonic between C2 and B2.
const bassOf = (key: Key) => 36 + key.root;

// The notes of a chord from the octave of C3, and its root as a bass note, all for `length` seconds.
function chord(key: Key, steps: readonly number[], at: number, length: number): SongNote[] {
  const base = 48 + key.root;
  return [
    ...steps.map((step) => ({ kind: 'chord' as const, at, midi: base + step, length })),
    { kind: 'bass', at, midi: bassOf(key) + ((steps[0] ?? 0) % 12), length },
  ];
}

// `key` replaces the key that the moves pick. The video spot (video/) forces C major pentatonic.
export function songOf(game: Game, key: Key = keyOf(game)): Song {
  if (game.moves.length === 0) throw new RangeError('a game without moves has no song');
  const loop = key.mode === 'major pentatonic' ? MAJOR_LOOP : MINOR_LOOP;
  const chordAt = (sixteenth: number) => loop[Math.floor(sixteenth / BAR) % loop.length] ?? loop[0];
  const step = game.moves.length > LONG_GAME ? 1 : 2;
  const notes: SongNote[] = [];

  let player = game.first;
  game.moves.forEach((cell, index) => {
    const position = index * step;
    const base = baseOf(key, player);
    let degree = degreeOf(cell);
    // On a beat, the melody takes the nearest scale note of the chord.
    const onBeat = position % BEAT === 0;
    if (onBeat) {
      const tones = chordAt(position).map((semitones) => (key.root + semitones) % 12);
      const fits = (candidate: number) => candidate >= 0 && tones.includes(pitchOf(candidate, base, key.mode) % 12);
      degree = [0, -1, 1, -2, 2].map((shift) => degree + shift).find(fits) ?? degree;
    }
    notes.push({ kind: 'melody', at: position * SIXTEENTH, midi: pitchOf(degree, base, key.mode), player, cell, level: onBeat ? 0.8 : 0.6, move: index });
    player = other(player);
  });

  // The ending starts on the beat after the last move. Under the moves, the bass plays each beat: the root
  // of the chord on beats 1 and 3, its fifth on beats 2 and 4, each one eighth note long.
  const end = Math.ceil((game.moves.length * step) / BEAT) * BEAT;
  for (let beat = 0; beat < end; beat += BEAT) {
    const steps = chordAt(beat);
    const root = bassOf(key) + (steps[0] % 12);
    notes.push({ kind: 'bass', at: beat * SIXTEENTH, midi: (beat / BEAT) % 2 === 0 ? root : root + 7, length: 2 * SIXTEENTH });
  }
  const winner = game.status.kind === 'won' || game.status.kind === 'timeout' ? game.status.winner : null;
  if (winner !== null) {
    // The winner runs up the tonic chord to the tonic one octave up in sixteenth notes, on the cells of the winning line.
    const cells = game.status.kind === 'won' ? game.status.line : [game.moves.at(-1) ?? 0];
    [0, third(key), 7, 12].forEach((semitones, index) => {
      const cell = cells[index % cells.length] ?? 0;
      notes.push({ kind: 'melody', at: (end + index) * SIXTEENTH, midi: baseOf(key, winner) + semitones, player: winner, cell, level: 0.75 });
    });
  } else {
    // A draw: a suspended chord, then the tonic on top of the final chord.
    notes.push(...chord(key, [0, 5, 7], end * SIXTEENTH, 2 * SIXTEENTH));
    notes.push({ kind: 'melody', at: (end + BEAT) * SIXTEENTH, midi: baseOf(key, game.first) + 12, player: game.first, cell: game.moves[0] ?? 0, level: 0.75 });
  }
  const last = (end + BEAT) * SIXTEENTH;
  notes.push(...chord(key, [0, third(key), 7], last, FINAL_RING));
  return { key, notes, duration: last + FINAL_RING + 0.1 };
}

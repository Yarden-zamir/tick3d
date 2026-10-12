// The note helpers of the tutorial and the ads: soft Cells melody notes, triangle chords and the Classic note of
// a layer, all in C major pentatonic (key.ts) and from the game's sound code.
import type { ScheduledSound } from '../../src/sound.ts';
import { SOUND_SETS, type SoundSet } from '../../src/sound-sets.ts';
import { SCALE, inKey, landing, midiOf, withoutBell } from './key.ts';

const CELLS = withoutBell(SOUND_SETS.cells);
// The melody notes play softer than a move: a calm mix (maintainer feedback on #119).
const LEVEL = 0.55;
// The chords: C major (C E G) and A minor (A C E), both inside the pentatonic scale.
export const C_MAJOR = [60, 64, 67] as const;
export const A_MINOR = [57, 60, 64] as const;
const CHORD_SECONDS = 0.8;

// The MIDI note of scale degree `degree` above C4.
export function pitchOf(degree: number): number {
  const step = SCALE[degree % SCALE.length];
  if (step === undefined) throw new RangeError(`no degree ${degree}`);
  return 60 + 12 * Math.floor(degree / SCALE.length) + step;
}

// A melody note with the voice of `cell` in `set`, cut to the key.
export function note(at: number, midi: number, cell: number, set: SoundSet = CELLS, level = LEVEL): ScheduledSound {
  return { at, note: { kind: 'melody', at: 0, midi, player: 'X', cell, level }, set: inKey(set, midi) };
}

// The notes of a chord. A chord note plays a soft triangle; the set only names it.
export const chord = (at: number, notes: readonly number[], length = CHORD_SECONDS): ScheduledSound[] =>
  notes.map((midi) => ({ at, note: { kind: 'chord', at: 0, midi, length }, set: CELLS }));

// The Classic note of a layer, as X plays it: C5, D5, E5 or G5.
export function layerNote(at: number, layer: number): ScheduledSound {
  const [voice] = SOUND_SETS.classic.voices(layer * 16, 'X');
  const pitch = voice === undefined ? undefined : landing(voice);
  if (pitch === undefined) throw new Error('Classic has no pitched voice');
  return note(at, Math.round(midiOf(pitch)), layer * 16, SOUND_SETS.classic, 0.9);
}

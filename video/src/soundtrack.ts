// The sounds of the soundtrack: the song of the game (src/song.ts) retimed to the bars of beats.json, the
// Classic layer notes, the preview strikes of the threats and the win jingle. Each note plays with the sound
// set of its bar. scripts/audio.ts renders them.
import { type SongNote, songOf } from '../../src/song.ts';
import { type ScheduledSound, previewVoices, winVoices } from '../../src/sound.ts';
import { SOUND_SETS, type SoundSet } from '../../src/sound-sets.ts';
import { inKey, landing, midiOf, withoutBell } from './key.ts';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, GAME, eventOf, eventsOf } from './timeline.ts';

// A sound of the spot. `at` counts whole sixteenths here; scripts/audio.ts turns it into seconds.
export type SpotSound = ScheduledSound;

// The key and the cut sets of src/key.ts. beats.json has the same key (songKey, checked by parseBeats).
export { SCALE, inKey } from './key.ts';

// The runs of one note per sixteenth (the moves of bar 3 and the replay) play softer, so they do not crowd the
// mix (maintainer feedback on #119).
const RUN_BAR = 3;
const RUN_LEVEL = 0.7;
const inRunBar = (at: number): boolean => Math.floor(at / SIXTEENTHS_PER_BAR) === RUN_BAR - 1;
const soft = (note: SongNote): SongNote => (note.kind === 'melody' ? { ...note, level: note.level * RUN_LEVEL } : note);

// The sound set of the bar of a sixteenth. The final chord after bar 8 keeps the set of bar 8.
function rawSetAt(at: number): SoundSet {
  const bar = BEATS.bars[Math.min(BEATS.bars.length - 1, Math.floor(at / SIXTEENTHS_PER_BAR))];
  if (bar === undefined) throw new RangeError(`no bar at sixteenth ${at}`);
  return bar.soundSet === 'cells' ? withoutBell(SOUND_SETS.cells) : SOUND_SETS[bar.soundSet];
}

const setAt = (at: number, midi: number): SoundSet => inKey(rawSetAt(at), midi);

// The pitch that the lead voice of a cell lands on in `set`.
function leadMidi(set: SoundSet, cell: number): number {
  const [lead] = set.voices(cell, 'X');
  const pitch = lead === undefined ? undefined : landing(lead);
  if (pitch === undefined) throw new Error(`${set.name} has no pitched voice for cell ${cell}`);
  return Math.round(midiOf(pitch));
}

export function spotSounds(): SpotSound[] {
  const song = songOf(GAME, BEATS.songKey);
  const beam = eventOf('beam');
  const replay = eventOf('replay');
  const finalChord = eventOf('final-chord');
  const finalAt = Math.max(...song.notes.filter((note) => note.kind === 'chord').map((note) => note.at));
  const notes: { at: number; note: SongNote }[] = [];

  let winRun = 0;
  for (const note of song.notes) {
    if (note.kind === 'melody' && note.move !== undefined) {
      const move = BEATS.moves[note.move];
      if (move === undefined) throw new RangeError(`no move ${note.move}`);
      notes.push({ at: move.at, note: inRunBar(move.at) ? soft(note) : note }, { at: replay.at + note.move, note: soft(note) });
    } else if (note.kind === 'melody') {
      // The winner's run up the tonic chord: one note on each cell of the beam.
      notes.push({ at: beam.at + winRun, note });
      winRun++;
    } else if (note.at === finalAt) {
      notes.push({ at: finalChord.at, note });
    } else if (note.kind !== 'bass') {
      // The bass line under the moves does not play: it made the mix noisy (maintainer feedback on #119).
      throw new Error(`the spot has no place for a ${note.kind} note at ${note.at} s`);
    }
  }

  // The layer slams: the Classic note of each layer, as X plays it.
  for (const slam of eventsOf('layer-slam')) {
    const [voice] = SOUND_SETS.classic.voices(slam.layer * 16, 'X');
    if (voice === undefined || voice.wave === 'noise') throw new Error('Classic has no pitched voice');
    notes.push({ at: slam.at, note: { kind: 'melody', at: 0, midi: Math.round(midiOf(voice.frequency)), player: 'X', cell: slam.layer * 16, level: 0.9 } });
  }

  const sounds: SpotSound[] = notes.map(({ at, note }) => ({ at, note, set: setAt(at, note.midi) }));

  // The threat pulses: the preview strike of each blinking cell, as the keypad plays it, in the set of the bar.
  for (const pulse of eventsOf('threat-pulse')) {
    const raw = rawSetAt(pulse.at);
    for (const cell of pulse.cells) sounds.push({ at: pulse.at, voices: previewVoices(inKey(raw, leadMidi(raw, cell)), cell) });
  }

  // The win jingle of the game, one note per sixteenth.
  const jingle = eventOf('win-jingle');
  winVoices(0).forEach((voice, i) => sounds.push({ at: jingle.at + i, voices: [voice] }));

  return sounds.sort((a, b) => a.at - b.at);
}

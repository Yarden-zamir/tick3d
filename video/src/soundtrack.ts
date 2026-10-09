// The sounds of the soundtrack: the song of the game (src/song.ts) retimed to the bars of beats.json, the
// Classic layer notes, the preview strikes of the threats and the win jingle. Each note plays with the sound
// set of its bar. scripts/audio.ts renders them.
import { type SongNote, scaleOf, songOf } from '../../src/song.ts';
import { type ScheduledSound, previewVoices, winVoices } from '../../src/sound.ts';
import { SOUND_SETS, type SoundSet, type Voice } from '../../src/sound-sets.ts';
import { SIZE, toCoords } from '../../src/game.ts';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, GAME, eventOf, eventsOf } from './timeline.ts';

// A sound of the spot. `at` counts whole sixteenths here; scripts/audio.ts turns it into seconds.
export type SpotSound = ScheduledSound;

export const SCALE = scaleOf(BEATS.songKey);

const midiOf = (frequency: number) => 69 + 12 * Math.log2(frequency / 440);
// The pitch that a pitched voice lands on: the end of its glide, if it glides.
const landing = (voice: Voice): number | undefined => (voice.wave === 'noise' ? undefined : (voice.slideTo ?? voice.frequency));

function withoutGlide(voice: Voice): Voice {
  if (voice.wave === 'noise' || voice.slideTo === undefined) return voice;
  const blip = { ...voice, frequency: voice.slideTo };
  delete blip.slideTo;
  delete blip.slideTime;
  return blip;
}

// A set without the added interval voices that leave the key (music.md): the Cells fifth over E and the
// Chiptune arpeggio steps off the scale. The voices of one interval, timbre partials included, come in a
// group as long as the voices of the thinnest cell of the row (column 0), so a whole group stays or goes.
// A Chiptune glide (jump, drop) starts outside the key, so the spot plays it as a blip on its landing note.
export function inKey(set: SoundSet, midi: number): SoundSet {
  return {
    ...set,
    voices(cell, player) {
      const voices = set.voices(cell, player).map(withoutGlide);
      const groupSize = set.voices(cell - toCoords(cell).column, player).length;
      const lead = voices[0] === undefined ? undefined : landing(voices[0]);
      if (lead === undefined) return voices;
      const kept: Voice[] = [];
      for (let start = 0; start < voices.length; start += groupSize) {
        const group = voices.slice(start, start + groupSize);
        const head = group[0] === undefined ? undefined : landing(group[0]);
        const pitch = head === undefined ? midi : Math.round(midi + midiOf(head) - midiOf(lead));
        if (SCALE.includes(((pitch % 12) + 12) % 12)) kept.push(...group);
      }
      return kept;
    },
  };
}

// The glass bell of Cells (the second row) rings for 0.9 s with partials off the harmonic series. In the spot it
// sounded harsh (maintainer feedback on #119), so the spot plays that row with the marimba of the first row.
const BELL_ROW = 1;
const withoutBell = (set: SoundSet): SoundSet => ({
  ...set,
  voices: (cell, player) => set.voices(toCoords(cell).row === BELL_ROW ? cell - SIZE : cell, player),
});

// The moves of bar 3 come one per sixteenth. They play softer, so the doubled speed does not crowd the mix (#119).
const RUN_BAR = 3;
const RUN_LEVEL = 0.55;
const inRunBar = (at: number): boolean => Math.floor(at / SIXTEENTHS_PER_BAR) === RUN_BAR - 1;

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
      notes.push({ at: move.at, note: inRunBar(move.at) ? { ...note, level: note.level * RUN_LEVEL } : note }, { at: replay.at + note.move, note });
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

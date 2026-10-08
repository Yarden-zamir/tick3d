// The notes of the soundtrack: the song of the game (src/song.ts), retimed to the bars of beats.json, and the
// Classic layer notes. Each note plays with the sound set of its bar. scripts/audio.ts renders them.
import { SIXTEENTH, type SongNote, scaleOf, songOf } from '../../src/song.ts';
import { SOUND_SETS, type SoundSet, type Voice } from '../../src/sound-sets.ts';
import { toCoords } from '../../src/game.ts';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, GAME, eventOf, eventsOf } from './timeline.ts';

// A note at a whole sixteenth of the spot, with the voices of its bar.
export type SpotNote = { at: number; note: SongNote; set: SoundSet };

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

// The sound set of the bar of a sixteenth. The final chord after bar 8 keeps the set of bar 8.
function setAt(at: number, midi: number): SoundSet {
  const bar = BEATS.bars[Math.min(BEATS.bars.length - 1, Math.floor(at / SIXTEENTHS_PER_BAR))];
  if (bar === undefined) throw new RangeError(`no bar at sixteenth ${at}`);
  return inKey(SOUND_SETS[bar.soundSet], midi);
}

const sixteenthOf = (seconds: number): number => {
  const s16 = seconds / SIXTEENTH;
  if (Math.abs(s16 - Math.round(s16)) > 1e-6) throw new RangeError(`a song note is off the grid: ${seconds} s`);
  return Math.round(s16);
};

export function spotNotes(): SpotNote[] {
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
      notes.push({ at: move.at, note }, { at: replay.at + note.move, note });
    } else if (note.kind === 'melody') {
      // The winner's run up the tonic chord: one note on each cell of the beam.
      notes.push({ at: beam.at + winRun, note });
      winRun++;
    } else if (note.at === finalAt) {
      notes.push({ at: finalChord.at, note });
    } else if (note.kind === 'bass') {
      const at = BEATS.songOffset + sixteenthOf(note.at);
      if (at < BEATS.bassUntil) notes.push({ at, note });
    } else {
      throw new Error(`the spot has no place for a ${note.kind} note at ${note.at} s`);
    }
  }

  // The layer slams: the Classic note of each layer, as X plays it.
  for (const slam of eventsOf('layer-slam')) {
    const [voice] = SOUND_SETS.classic.voices(slam.layer * 16, 'X');
    if (voice === undefined || voice.wave === 'noise') throw new Error('Classic has no pitched voice');
    notes.push({ at: slam.at, note: { kind: 'melody', at: 0, midi: Math.round(midiOf(voice.frequency)), player: 'X', cell: slam.layer * 16, level: 0.9 } });
  }

  return notes.map(({ at, note }) => ({ at, note, set: setAt(at, note.midi) })).sort((a, b) => a.at - b.at);
}

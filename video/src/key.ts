// The key of every video: C major pentatonic (the maintainer audio rule on #119), and the sound sets cut to it.
import { scaleOf } from '../../src/song.ts';
import type { SoundSet, Voice } from '../../src/sound-sets.ts';
import { SIZE, toCoords } from '../../src/game.ts';

const KEY = { root: 0, mode: 'major pentatonic' } as const;
export const SCALE = scaleOf(KEY);

export const midiOf = (frequency: number) => 69 + 12 * Math.log2(frequency / 440);
// The pitch that a pitched voice lands on: the end of its glide, if it glides.
export const landing = (voice: Voice): number | undefined => (voice.wave === 'noise' ? undefined : (voice.slideTo ?? voice.frequency));

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
export const withoutBell = (set: SoundSet): SoundSet => ({
  ...set,
  voices: (cell, player) => set.voices(toCoords(cell).row === BELL_ROW ? cell - SIZE : cell, player),
});

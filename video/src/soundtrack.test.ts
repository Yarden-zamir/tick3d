import { describe, expect, it } from 'vitest';
import { SOUND_SETS, type Voice } from '../../src/sound-sets.ts';
import { SPOT_SIXTEENTHS } from '../creative/beats.ts';
import { SCALE, inKey, spotNotes } from './soundtrack.ts';
import { BEATS } from './timeline.ts';

const notes = spotNotes();
const pitchClass = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;
const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const pitch = (voice: Voice) => (voice.wave === 'noise' ? undefined : midiOf(voice.slideTo ?? voice.frequency));

describe('the soundtrack', () => {
  it('plays every note on a whole sixteenth inside the spot', () => {
    for (const { at } of notes) {
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(SPOT_SIXTEENTHS);
    }
  });

  it('keeps every note in C major pentatonic', () => {
    expect(SCALE).toEqual([0, 2, 4, 7, 9]);
    for (const { note } of notes) expect(SCALE).toContain(pitchClass(note.midi));
  });

  it('keeps every added interval voice in the key: the fifths and thirds over the note', () => {
    // Interval voices sit a just fifth or third (or a fifth plus an octave) over the lead. Bell and marimba partials are timbre.
    const added = notes.flatMap(({ note, set }) => {
      if (note.kind !== 'melody') return [];
      const voices = set.voices(note.cell, note.player);
      const lead = voices[0] === undefined ? undefined : pitch(voices[0]);
      return voices.flatMap((voice) => {
        const p = pitch(voice);
        if (lead === undefined || p === undefined) return [];
        const ratio = 2 ** ((p - lead) / 12);
        return [1.25, 1.5, 3].some((r) => Math.abs(ratio - r) < 0.001) ? [pitchClass(note.midi + p - lead)] : [];
      });
    });
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((pc) => !SCALE.includes(pc))).toEqual([]);
  });

  it('drops the Cells fifth over E, and keeps it over C', () => {
    const wide = 3; // Column 3 of Cells: the note, its fifth and its octave.
    expect(inKey(SOUND_SETS.cells, 64).voices(wide, 'X').length).toBeLessThan(SOUND_SETS.cells.voices(wide, 'X').length);
    expect(inKey(SOUND_SETS.cells, 60).voices(wide, 'X')).toHaveLength(SOUND_SETS.cells.voices(wide, 'X').length);
  });

  it('hits the bar 1 downbeat, the win on the bar 5 downbeat and the end card on the bar 7 downbeat', () => {
    const onsets = new Set(notes.map((n) => n.at));
    for (const bar of [1, 5, 7]) expect(onsets).toContain((bar - 1) * 16);
  });

  it('uses only Classic, Cells and Chiptune', () => {
    const names = new Set(notes.map((n) => n.set.name));
    expect([...names].every((name) => ['Classic', 'Cells', 'Chiptune'].includes(name))).toBe(true);
    expect(BEATS.bars.every((bar) => ['classic', 'cells', 'chiptune'].includes(bar.soundSet))).toBe(true);
  });
});

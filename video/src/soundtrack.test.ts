import { describe, expect, it } from 'vitest';
import { scheduleNotes } from '../../src/sound.ts';
import { SOUND_SETS } from '../../src/sound-sets.ts';
import { SPOT_SIXTEENTHS } from '../creative/beats.ts';
import { SCALE, type SpotSound, inKey, spotSounds } from './soundtrack.ts';
import { BEATS, eventsOf } from './timeline.ts';

const sounds = spotSounds();
const notes = sounds.flatMap((sound) => ('note' in sound ? [sound] : []));
const pitchClass = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;
const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);

// Schedules one sound into a fake audio context, and returns the pitches of every oscillator that the sound
// starts: the value set at the start, then the target of a glide. A vibrato LFO is an oscillator too, far below
// 30 Hz, and it is left out.
function oscillatorPitches(sound: SpotSound): number[][] {
  const pitches: number[][] = [];
  const param = () => ({ setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });
  const node = (extra: object = {}): object => ({ ...extra, connect: (to: unknown) => to });
  const ctx = {
    currentTime: 0,
    sampleRate: 44_100,
    destination: {},
    createBuffer: () => ({ getChannelData: () => new Float32Array(44_100) }),
    createBufferSource: () => node({ start: () => undefined, stop: () => undefined }),
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), ratio: param(), attack: param(), release: param() }),
    createStereoPanner: () => node({ pan: param() }),
    createBiquadFilter: () => node({ frequency: param(), Q: param() }),
    createOscillator: () => {
      const own: number[] = [];
      pitches.push(own);
      const record = (value: number) => own.push(value);
      return node({ frequency: { setValueAtTime: record, exponentialRampToValueAtTime: record }, start: () => undefined, stop: () => undefined });
    },
  };
  scheduleNotes([{ ...sound, at: 0 }], ctx as unknown as BaseAudioContext);
  return pitches.filter((own) => own.every((hz) => hz >= 30));
}

describe('the soundtrack', () => {
  it('plays every sound on a whole sixteenth inside the spot', () => {
    for (const { at } of sounds) {
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(SPOT_SIXTEENTHS);
    }
  });

  it('keeps every song note in C major pentatonic', () => {
    expect(SCALE).toEqual([0, 2, 4, 7, 9]);
    for (const { note } of notes) expect(SCALE).toContain(pitchClass(note.midi));
  });

  it('keeps every pitched voice that it schedules in C, D, E, G or A (the maintainer audio rule on #119)', () => {
    // A voice within 15 cents of a whole number of semitones from the lead of its sound is a pitch: the lead, an
    // added interval, an octave, a bass or chord note. The others are the timbre partials of a bell or a
    // marimba (2.76, 5.4 times the pitch), and they are exempt.
    let pitched = 0;
    for (const sound of sounds) {
      const voices = oscillatorPitches(sound);
      const lead = voices[0]?.[0];
      expect(lead, `a pitched lead voice at sixteenth ${sound.at}`).toBeDefined();
      if (lead === undefined) continue;
      for (const hz of voices.flat()) {
        const semitones = 12 * Math.log2(hz / lead);
        if (Math.abs(semitones - Math.round(semitones)) > 0.15) continue;
        pitched++;
        expect(SCALE, `${hz.toFixed(1)} Hz at sixteenth ${sound.at}`).toContain(pitchClass(midiOf(hz)));
      }
    }
    // Most sounds play more than one pitched voice, so the check saw the intervals, not only the leads.
    expect(pitched).toBeGreaterThan(sounds.length);
  });

  it('drops the Cells fifth over E, and keeps it over C', () => {
    const wide = 3; // Column 3 of Cells: the note, its fifth and its octave.
    expect(inKey(SOUND_SETS.cells, 64).voices(wide, 'X').length).toBeLessThan(SOUND_SETS.cells.voices(wide, 'X').length);
    expect(inKey(SOUND_SETS.cells, 60).voices(wide, 'X')).toHaveLength(SOUND_SETS.cells.voices(wide, 'X').length);
  });

  it('hits the bar 1 downbeat, the win on the bar 5 downbeat and the end card on the bar 7 downbeat', () => {
    const onsets = new Set(sounds.map((sound) => sound.at));
    for (const bar of [1, 5, 7]) expect(onsets).toContain((bar - 1) * 16);
  });

  it('plays a preview strike on every threat pulse and the five jingle notes from the win jingle', () => {
    const strikes = sounds.filter((sound) => 'voices' in sound);
    for (const pulse of eventsOf('threat-pulse')) expect(strikes.filter((sound) => sound.at === pulse.at)).toHaveLength(pulse.cells.length);
    for (const jingle of eventsOf('win-jingle')) for (let i = 0; i < 5; i++) expect(strikes.some((sound) => sound.at === jingle.at + i)).toBe(true);
  });

  it('uses only Classic, Cells and Chiptune', () => {
    const names = new Set(notes.map((sound) => sound.set.name));
    expect([...names].every((name) => ['Classic', 'Cells', 'Chiptune'].includes(name))).toBe(true);
    expect(BEATS.bars.every((bar) => ['classic', 'cells', 'chiptune'].includes(bar.soundSet))).toBe(true);
  });
});

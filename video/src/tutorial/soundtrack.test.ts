import { describe, expect, it } from 'vitest';
import { linesThrough } from '../../../src/game.ts';
import { SCALE } from '../key.ts';
import { oscillatorPitches } from '../oscillators.ts';
import { END, eventsOf } from './plan.ts';
import { tutorialSounds } from './soundtrack.ts';

const sounds = tutorialSounds();
const notes = sounds.flatMap((sound) => ('note' in sound ? [sound] : []));
const melodyAt = (at: number) => notes.filter((sound) => sound.at === at && sound.note.kind === 'melody');
const pitchClass = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;
const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);

describe('the tutorial soundtrack', () => {
  it('plays every sound on a whole sixteenth inside the tutorial', () => {
    for (const { at } of sounds) {
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(END);
    }
  });

  it('keeps every note and every pitched voice in C, D, E, G or A (the maintainer audio rule on #119)', () => {
    expect(SCALE).toEqual([0, 2, 4, 7, 9]);
    for (const { note } of notes) expect(SCALE).toContain(pitchClass(note.midi));
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
    expect(pitched).toBeGreaterThan(sounds.length);
  });

  it('plays no bass and no glass bell (maintainer feedback on #119)', () => {
    expect(notes.some(({ note }) => note.kind === 'bass')).toBe(false);
    // The glass bell of Cells is the only voice with a partial at 2.76 times its pitch.
    for (const sound of sounds) {
      const [lead, ...rest] = oscillatorPitches(sound).map((own) => own[0] ?? 0);
      expect(lead !== undefined && rest.some((hz) => Math.abs(hz / lead - 2.76) < 0.01), `a bell partial at sixteenth ${sound.at}`).toBe(false);
    }
  });

  it('uses only Classic, Cells and Chiptune', () => {
    for (const { set } of notes) expect(['Classic', 'Cells', 'Chiptune']).toContain(set.name);
  });

  it('plays a soft note for each cell of an example line and for each line through a cell', () => {
    for (const { event } of eventsOf('line')) {
      event.line.forEach((cell, i) => expect(melodyAt(event.at + i * event.gap).map((sound) => sound.note.kind === 'melody' && sound.note.cell)).toContain(cell));
    }
    for (const { event } of eventsOf('through')) {
      const count = linesThrough(event.cell).length;
      for (let i = 1; i <= count; i++) expect(melodyAt(event.at + event.gap * i), `line ${i} of cell ${event.cell}`).toHaveLength(1);
    }
    for (const { note } of notes.filter((sound) => sound.note.kind === 'melody')) expect('level' in note && note.level).toBeLessThan(1);
  });
});

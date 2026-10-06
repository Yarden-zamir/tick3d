import { describe, expect, it } from 'vitest';
import { CELL_COUNT, toCell } from './game.ts';
import { SOUND_SET_GROUPS, SOUND_SET_IDS, SOUND_SETS, type Voice, harmonyNotes, midiHz } from './sound-sets.ts';

const cells = Array.from({ length: CELL_COUNT }, (_, cell) => cell);
const fingerprint = (voices: readonly Voice[]) => JSON.stringify(voices);
describe('sound sets', () => {
  it('puts every set in exactly one menu group', () => {
    expect(SOUND_SET_GROUPS.flatMap((group) => group.ids).toSorted()).toEqual([...SOUND_SET_IDS].toSorted());
  });

  for (const id of SOUND_SET_IDS) {
    const set = SOUND_SETS[id];
    describe(`the ${id} set`, () => {
      it('plays X and O differently in every cell', () => {
        for (const cell of cells) expect(fingerprint(set.voices(cell, 'O'))).not.toBe(fingerprint(set.voices(cell, 'X')));
      });

      it('keeps every voice short and audible', () => {
        for (const cell of cells) {
          for (const player of ['X', 'O'] as const) {
            const voices = set.voices(cell, player);
            expect(voices.length).toBeGreaterThan(0);
            for (const voice of voices) {
              expect(voice.level).toBeGreaterThan(0);
              // The glass bell of Cells rings longest. The other sets stay near 0.6 s.
              expect((voice.at ?? 0) + voice.decay).toBeLessThanOrEqual(0.9);
              expect(Math.abs(voice.pan ?? 0)).toBeLessThanOrEqual(1);
            }
          }
        }
      });

      if (id === 'classic') return;

      it('gives every cell its own sound, and names each part with four different words', () => {
        expect(new Set(cells.map((cell) => fingerprint(set.voices(cell, 'X')))).size).toBe(CELL_COUNT);
        expect(new Set(cells.map((cell) => fingerprint(set.voices(cell, 'O')))).size).toBe(CELL_COUNT);
        expect(set.parts).toBeDefined();
        for (const part of Object.values(set.parts ?? {})) expect(new Set(part.names).size).toBe(4);
      });
    });
  }
});

describe('the Classic set', () => {
  it('plays the old note of the layer: C5, D5, E5, G5, and O an octave lower', () => {
    const notes = [523.25, 587.33, 659.25, 783.99];
    notes.forEach((note, layer) => {
      for (const [row, column] of [[0, 0], [3, 2]] as const) {
        const cell = toCell({ layer, row, column });
        const [x] = SOUND_SETS.classic.voices(cell, 'X');
        const [o] = SOUND_SETS.classic.voices(cell, 'O');
        expect(x).toMatchObject({ wave: 'triangle', frequency: note, decay: 0.18 });
        expect(o).toMatchObject({ wave: 'triangle', frequency: note / 2 });
      }
    });
  });
});

describe('the Classic, pitched set', () => {
  it('keeps the Classic tone and note, and moves it by octaves for the rows and sideways for the columns', () => {
    const at = (layer: number, row: number, column: number, player: 'X' | 'O' = 'X') =>
      SOUND_SETS.pitched.voices(toCell({ layer, row, column }), player);
    const classic = SOUND_SETS.classic.voices(toCell({ layer: 1, row: 0, column: 0 }), 'X');
    // Row 2 sounds as Classic did, apart from the side.
    expect(at(1, 1, 0).map(({ pan: _pan, ...voice }) => voice)).toEqual(classic);
    for (const [row, octave] of [[0, 2], [2, 1 / 2], [3, 1 / 4]] as const) {
      expect(at(1, row, 0)[0]).toMatchObject({ wave: 'triangle', frequency: 587.33 * octave });
    }
    expect(at(1, 1, 0, 'O')[0]).toMatchObject({ frequency: 587.33 / 2 });
    expect(at(1, 1, 0)[0]?.pan).toBeLessThan(at(1, 1, 3)[0]?.pan ?? -1);
  });
});

describe('the Cells set', () => {
  const pitch = (voices: readonly Voice[]) => Math.min(...voices.map((voice) => ('frequency' in voice ? voice.frequency : Infinity)));
  const pan = (voices: readonly Voice[]) => voices[0]?.pan ?? 0;
  const at = (layer: number, row: number, column: number) => SOUND_SETS.cells.voices(toCell({ layer, row, column }), 'X');

  it('takes the pitch from the layer and the side from the column, and O sounds an octave lower', () => {
    for (const position of [1, 2, 3]) {
      expect(pitch(at(position, 0, 0))).toBeGreaterThan(pitch(at(position - 1, 0, 0)));
      expect(pan(at(1, 2, position))).toBeGreaterThan(pan(at(1, 2, position - 1)));
    }
    expect(pitch(SOUND_SETS.cells.voices(0, 'O'))).toBe(pitch(at(0, 0, 0)) / 2);
  });
});

describe('the Harmony set', () => {
  const notes = (layer: number, row: number, column: number) => harmonyNotes(toCell({ layer, row, column }));

  it('tunes equal temperament to A4 = 440 Hz', () => {
    expect(midiHz(69)).toBe(440);
    expect(midiHz(60)).toBeCloseTo(261.63, 2);
    expect(midiHz(81)).toBeCloseTo(880, 6);
  });

  it('plays the chords of C major in their voicings', () => {
    // C major in root position, octave 4: C4 E4 G4.
    expect(notes(1, 0, 0)).toEqual([60, 64, 67]);
    // G major, 1st inversion, octave 4: B4 D5 G5.
    expect(notes(1, 2, 1)).toEqual([71, 74, 79]);
    // F major, 2nd inversion, octave 3: C4 F4 A4.
    expect(notes(0, 1, 2)).toEqual([60, 65, 69]);
    // The seventh chords: Cmaj7, Fmaj7, G7 (a dominant seventh) and Am7, in octave 3.
    expect(notes(0, 0, 3)).toEqual([48, 52, 55, 59]);
    expect(notes(0, 1, 3)).toEqual([53, 57, 60, 64]);
    expect(notes(0, 2, 3)).toEqual([55, 59, 62, 65]);
    expect(notes(0, 3, 3)).toEqual([57, 60, 64, 67]);
    // A minor in root position, octave 6: A6 = 1760 Hz.
    expect(midiHz(notes(3, 3, 0)[0] ?? 0)).toBeCloseTo(1760, 6);
  });

  it('plays every note of the chord, and X and O play the same pitches', () => {
    const cell = toCell({ layer: 1, row: 2, column: 3 });
    const pitches = (player: 'X' | 'O') => new Set(SOUND_SETS.harmony.voices(cell, player).map((voice) => ('frequency' in voice ? voice.frequency : 0)));
    const chord = harmonyNotes(cell).map(midiHz);
    for (const player of ['X', 'O'] as const) for (const f of chord) expect(pitches(player)).toContain(f);
  });
});

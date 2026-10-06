import { describe, expect, it } from 'vitest';
import { CELL_COUNT, toCell } from './game.ts';
import { SOUND_SET_GROUPS, SOUND_SET_IDS, SOUND_SETS, type Voice } from './sound-sets.ts';

const cells = Array.from({ length: CELL_COUNT }, (_, cell) => cell);
const fingerprint = (voices: readonly Voice[]) => JSON.stringify(voices);
// The loudest a move can get: the most voice levels that sound at the same moment.
const peak = (voices: readonly Voice[]) =>
  Math.max(
    ...voices.map(({ at: moment = 0 }) =>
      voices.filter(({ at = 0, decay }) => at <= moment && moment < at + decay).reduce((sum, voice) => sum + voice.level, 0),
    ),
  );

describe('sound sets', () => {
  it('puts every set in exactly one menu group', () => {
    expect(Object.values(SOUND_SET_GROUPS).flat().toSorted()).toEqual([...SOUND_SET_IDS].toSorted());
  });

  for (const id of SOUND_SET_IDS) {
    const set = SOUND_SETS[id];
    describe(`the ${id} set`, () => {
      it('plays X and O differently in every cell', () => {
        for (const cell of cells) expect(fingerprint(set.voices(cell, 'O'))).not.toBe(fingerprint(set.voices(cell, 'X')));
      });

      it('keeps every voice short, audible and inside the headroom', () => {
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
            // The partials of a move rarely peak together, so this bound leaves room for a fast series of moves.
            expect(peak(voices)).toBeLessThanOrEqual(0.75);
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

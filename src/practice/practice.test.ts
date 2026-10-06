import { describe, expect, it } from 'vitest';
import { CELL_COUNT } from '../game.ts';
import { ECHO_POINTS, MAX_ROUND_MS, PRESETS, ROUNDS, beats, echoPoints, heatOf, parseBests, parsePracticeRun, seededRandom, summarize, targetSteps } from './practice.ts';

describe('seeded targets', () => {
  it('gives the same targets for the same seed, and others for another seed', () => {
    expect(targetSteps(42, 'normal', 10)).toEqual(targetSteps(42, 'normal', 10));
    expect(targetSteps(42, 'normal', 10)).not.toEqual(targetSteps(43, 'normal', 10));
    const random = seededRandom(7);
    const values = Array.from({ length: 1000 }, random);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(() => seededRandom(-1)).toThrow(RangeError);
    expect(() => seededRandom(2 ** 32)).toThrow(RangeError);
  });

  it('keeps each target inside the spread of its preset, and never on the target before', () => {
    for (const preset of ['easy', 'normal', 'hard'] as const) {
      for (let seed = 0; seed < 50; seed++) {
        const steps = targetSteps(seed, preset, 10);
        expect(steps).toHaveLength(10);
        expect(steps.every((step) => Number.isInteger(step) && step >= 0 && step < CELL_COUNT)).toBe(true);
        for (let i = 1; i < steps.length; i++) {
          const jump = Math.abs((steps[i] ?? 0) - (steps[i - 1] ?? 0));
          expect(jump).toBeGreaterThanOrEqual(2);
          expect(jump).toBeLessThanOrEqual(PRESETS[preset].maxJump);
        }
      }
    }
  });
});

describe('heat', () => {
  it('gets hotter near the target and says which way to slide', () => {
    expect(heatOf(10.5, 10)).toMatchObject({ word: 'On it', direction: 'here', share: 1 });
    expect(heatOf(9.2, 10)).toMatchObject({ word: 'Hot', direction: 'up' });
    expect(heatOf(14, 10)).toMatchObject({ word: 'Warm', direction: 'down' });
    expect(heatOf(40, 10)).toMatchObject({ word: 'Cold', share: 0 });
    expect(heatOf(12, 10).share).toBeGreaterThan(heatOf(20, 10).share);
  });
});

describe('scores', () => {
  it('gives echo points by the distance in layer, row and column', () => {
    expect(echoPoints(21, 21)).toBe(ECHO_POINTS);
    // Cell 22 is one column to the right of 21.
    expect(echoPoints(21, 22)).toBe(75);
    expect(echoPoints(0, 63)).toBe(0);
  });

  it('sums a run and finds the best and the worst round', () => {
    expect(summarize([2000, 1000, 3000])).toEqual({ totalMs: 6000, averageMs: 2000, bestMs: 1000, worstMs: 3000 });
    expect(() => summarize([])).toThrow(RangeError);
  });

  it('ranks a target run by time, and an echo run by points, then time', () => {
    expect(beats('targets', { totalMs: 9000, score: 10 }, { totalMs: 9500, score: 10 })).toBe(true);
    expect(beats('echo', { totalMs: 30_000, score: 700 }, { totalMs: 9000, score: 600 })).toBe(true);
    expect(beats('echo', { totalMs: 9000, score: 600 }, { totalMs: 9500, score: 600 })).toBe(true);
  });
});

describe('practice run check', () => {
  const run = { id: 'run-12345678', mode: 'targets', preset: 'easy', roundMs: Array<number>(ROUNDS.targets).fill(1500), score: ROUNDS.targets };

  it('takes a run that the page can make', () => {
    expect(parsePracticeRun(run)).toEqual(run);
    const echo = { ...run, mode: 'echo', roundMs: Array<number>(ROUNDS.echo).fill(4000), score: 650 };
    expect(parsePracticeRun(echo)).toEqual(echo);
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      { ...run, id: 'short' },
      { ...run, id: 'run 12345678' },
      { ...run, mode: 'karaoke' },
      { ...run, preset: 'insane' },
      { ...run, roundMs: [1500] },
      { ...run, roundMs: [...run.roundMs.slice(1), -1] },
      { ...run, roundMs: [...run.roundMs.slice(1), MAX_ROUND_MS + 1] },
      { ...run, roundMs: [...run.roundMs.slice(1), 1.5] },
      { ...run, score: 9 },
      { ...run, mode: 'echo', roundMs: Array<number>(ROUNDS.echo).fill(4000), score: ECHO_POINTS * ROUNDS.echo + 1 },
    ]) {
      expect(parsePracticeRun(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('device bests', () => {
  it('reads back valid bests and leaves out broken entries', () => {
    const best = { 'targets:easy': { totalMs: 12_000, score: 10, at: 5 }, 'echo:hard': { totalMs: -1, score: 0, at: 5 }, 'karaoke:easy': { totalMs: 1, score: 1, at: 1 } };
    expect(parseBests({ version: 1, best })).toEqual({ 'targets:easy': { totalMs: 12_000, score: 10, at: 5 } });
    expect(parseBests({ version: 2, best })).toEqual({});
    expect(parseBests(null)).toEqual({});
  });
});

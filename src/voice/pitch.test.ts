import { describe, expect, it } from 'vitest';
import { bufferSize, detectPitch, rms } from './pitch.ts';

const RATE = 48_000;
const SIZE = bufferSize(RATE);

// A seeded random source, so the noise is the same on every run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

// `harmonics` lists the level of each partial, the fundamental first. A hum has strong overtones.
function tone(frequency: number, harmonics: readonly number[] = [1], noise = 0, level = 0.5): Float32Array {
  const next = random(7);
  return Float32Array.from({ length: SIZE }, (_, index) => {
    const time = index / RATE;
    const partials = harmonics.reduce((sum, amount, partial) => sum + amount * Math.sin(2 * Math.PI * frequency * (partial + 1) * time + partial), 0);
    return level * partials + noise * (next() * 2 - 1);
  });
}

describe('pitch detection', () => {
  it.each([523.25, 784, 1500, 110])('finds a sine at %d Hz within 2 Hz', (frequency) => {
    const pitch = detectPitch(tone(frequency), RATE);
    expect(pitch?.frequency).toBeCloseTo(frequency, 0);
    expect(Math.abs((pitch?.frequency ?? 0) - frequency)).toBeLessThan(2);
  });

  it('finds the fundamental of a hum with strong overtones, not an octave', () => {
    const pitch = detectPitch(tone(150, [1, 0.8, 0.6, 0.4], 0, 0.2), RATE);
    expect(Math.abs((pitch?.frequency ?? 0) - 150)).toBeLessThan(2);
  });

  it('finds a whistle under some noise', () => {
    const pitch = detectPitch(tone(880, [1], 0.05), RATE);
    expect(Math.abs((pitch?.frequency ?? 0) - 880)).toBeLessThan(3);
  });

  it('returns null for silence, quiet hiss and white noise', () => {
    expect(detectPitch(new Float32Array(SIZE), RATE)).toBeNull();
    expect(detectPitch(tone(440, [], 0.005), RATE)).toBeNull();
    for (const seed of [1, 2, 3]) {
      const next = random(seed);
      expect(detectPitch(Float32Array.from({ length: SIZE }, () => next() * 2 - 1), RATE)).toBeNull();
    }
  });

  it('returns null for a tone above the range', () => {
    expect(detectPitch(tone(6000), RATE)).toBeNull();
  });

  it('works at the common sample rates', () => {
    for (const rate of [44_100, 96_000]) {
      const samples = Float32Array.from({ length: bufferSize(rate) }, (_, index) => 0.5 * Math.sin((2 * Math.PI * 660 * index) / rate));
      expect(Math.abs((detectPitch(samples, rate)?.frequency ?? 0) - 660)).toBeLessThan(2);
    }
  });

  it('refuses a buffer that is too short for the lowest pitch', () => {
    expect(() => detectPitch(new Float32Array(256), RATE)).toThrow(RangeError);
    expect(() => detectPitch(new Float32Array(SIZE), 0)).toThrow(RangeError);
  });

  it('measures the level', () => {
    expect(rms(new Float32Array(SIZE))).toBe(0);
    expect(rms(tone(440, [1], 0, 1))).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

import { describe, expect, it } from 'vitest';
import { isSmallRange, median, rangeFrom, typedRange } from './calibration.ts';

describe('calibration', () => {
  it('takes the median of each step, so a few odd frames do not move the range', () => {
    expect(rangeFrom([210, 205, 900, 212, 208], [1350, 1340, 100, 1360])).toEqual({ low: 210, high: 1350 });
    expect(median([3, 1, 2])).toBe(2);
    expect(() => median([])).toThrow(RangeError);
  });

  it('asks for a retry when a step has no pitch, the low sound is not below the high sound, or the gap is under half an octave', () => {
    expect(rangeFrom([], [800])).toBe('silent');
    expect(rangeFrom([400], [])).toBe('silent');
    expect(rangeFrom([600], [600])).toBe('order');
    expect(rangeFrom([900], [300])).toBe('order');
    expect(rangeFrom([400], [560])).toBe('narrow');
    expect(rangeFrom([400], [570])).toEqual({ low: 400, high: 570 });
  });

  it('flags a range under one octave as small', () => {
    expect(isSmallRange({ low: 300, high: 590 })).toBe(true);
    expect(isSmallRange({ low: 300, high: 600 })).toBe(false);
  });

  it('takes a typed range inside the detector range, with half an octave at least', () => {
    expect(typedRange(200, 800)).toEqual({ low: 200, high: 800 });
    for (const [low, high] of [[Number.NaN, 800], [50, 800], [200, 5000], [800, 200], [400, 560]] as const) {
      expect(typeof typedRange(low, high), `${low} to ${high}`).toBe('string');
    }
  });
});

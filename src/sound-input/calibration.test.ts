import { describe, expect, it } from 'vitest';
import { isSmallRange, median, parseRange, rangeFrom, storedRange } from './calibration.ts';

describe('calibration', () => {
  it('takes the median of each step, so a few odd frames do not move the range', () => {
    expect(rangeFrom([210, 205, 900, 212, 208], [1350, 1340, 100, 1360])).toEqual({ low: 210, high: 1350 });
    expect(median([3, 1, 2])).toBe(2);
    expect(() => median([])).toThrow(RangeError);
  });

  it('asks for a retry when a step has no pitch, or the low sound is not below the high sound', () => {
    expect(rangeFrom([], [800])).toBeNull();
    expect(rangeFrom([400], [])).toBeNull();
    expect(rangeFrom([600], [600])).toBeNull();
    expect(rangeFrom([900], [300])).toBeNull();
  });

  it('flags a range under one octave as small', () => {
    expect(isSmallRange({ low: 300, high: 590 })).toBe(true);
    expect(isSmallRange({ low: 300, high: 600 })).toBe(false);
  });

  it('reads back a stored range, and treats anything else as not calibrated', () => {
    const range = { low: 210, high: 1350 };
    expect(parseRange(JSON.parse(JSON.stringify(storedRange(range))))).toEqual(range);
    for (const bad of [null, 'x', 42, {}, { low: 210, high: 1350 }, { version: 2, low: 210, high: 1350 }, { version: 1, low: 1350, high: 210 }, { version: 1, low: -1, high: 300 }, { version: 1, low: 210, high: '1350' }, { version: 1, low: 210, high: Infinity }]) {
      expect(parseRange(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

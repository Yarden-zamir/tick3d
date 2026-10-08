import { describe, expect, it } from 'vitest';
import { holdStep, marginAt } from './sticky.ts';

const sticky = { share: 0.5, buildUpMs: 1000 };
const off = { share: 0, buildUpMs: 1000 };

describe('sticky cells', () => {
  it('grows the margin from zero to the stickiness over the build-up time, then stops', () => {
    expect(marginAt(0, sticky)).toBe(0);
    expect(marginAt(500, sticky)).toBeCloseTo(0.25);
    expect(marginAt(1000, sticky)).toBe(0.5);
    expect(marginAt(5000, sticky)).toBe(0.5);
    // No build-up time: the full margin at once.
    expect(marginAt(0, { share: 0.5, buildUpMs: 0 })).toBe(0.5);
  });

  it('has no stickiness when it is off', () => {
    expect(marginAt(10_000, off)).toBe(0);
    const held = holdStep(null, 10.5, 0, off);
    expect(holdStep(held, 11.01, 5000, off).step).toBe(11);
    expect(holdStep(held, 9.99, 5000, off).step).toBe(9);
  });

  it('moves at once from a fresh cell, and holds a cell that the player held long', () => {
    const fresh = holdStep(null, 10.5, 0, sticky);
    expect(fresh).toEqual({ step: 10, since: 0 });
    expect(holdStep(fresh, 11.1, 1, sticky).step).toBe(11);
    // After the build-up, a wobble of less than half a cell past the border keeps the cell.
    expect(holdStep(fresh, 11.4, 1000, sticky)).toBe(fresh);
    expect(holdStep(fresh, 9.6, 1000, sticky)).toBe(fresh);
    // Past the margin, the light moves, and the new cell starts with no margin.
    const moved = holdStep(fresh, 11.6, 1000, sticky);
    expect(moved).toEqual({ step: 11, since: 1000 });
    expect(holdStep(moved, 10.95, 1001, sticky).step).toBe(10);
  });

  it('keeps the start time while the pitch stays in the cell', () => {
    const held = holdStep(null, 20.2, 100, sticky);
    expect(holdStep(held, 20.9, 900, sticky)).toEqual({ step: 20, since: 100 });
    expect(() => holdStep(held, Number.NaN, 900, sticky)).toThrow(RangeError);
  });
});

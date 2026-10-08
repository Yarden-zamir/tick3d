import { describe, expect, it } from 'vitest';
import { DEFAULT_TILT, MAX_TILT_STEPS, TILT_DEAD_ZONE, TILT_FULL, TILT_SMOOTH_MS, smoothToward, tiltTarget } from './tilt.ts';

describe('tilt defaults', () => {
  it('is off by default, with a strength of 2 cells out of at most 3', () => {
    expect(DEFAULT_TILT).toEqual({ on: false, steps: 2 });
    expect(MAX_TILT_STEPS).toBe(3);
  });
});

describe('tilt target', () => {
  it('gives no nudge inside the dead zone around neutral', () => {
    for (const beta of [40, 40 + TILT_DEAD_ZONE, 40 - TILT_DEAD_ZONE, 41.5, 38.5]) expect(tiltTarget(beta, 40, 3), String(beta)).toBe(0);
  });

  it('grows past the dead zone and stops at the stored strength', () => {
    const half = tiltTarget(40 + (TILT_DEAD_ZONE + TILT_FULL) / 2, 40, 2);
    expect(half).toBeCloseTo(1);
    expect(tiltTarget(40 + TILT_FULL, 40, 2)).toBeCloseTo(2);
    for (const steps of [1, 2, MAX_TILT_STEPS]) {
      for (const beta of [40 + TILT_FULL + 5, 120, 179]) expect(tiltTarget(beta, 40, steps), `${steps} at ${beta}`).toBe(steps);
      expect(tiltTarget(-100, 40, steps), `${steps} down`).toBe(-steps);
    }
  });

  it('moves up for the top edge toward the player, and down for away', () => {
    expect(tiltTarget(48, 40, 3)).toBeGreaterThan(0);
    expect(tiltTarget(32, 40, 3)).toBeLessThan(0);
    expect(tiltTarget(32, 40, 3)).toBeCloseTo(-tiltTarget(48, 40, 3));
  });

  it('takes the short way around ±180°', () => {
    expect(tiltTarget(-178, 178, 3)).toBeGreaterThan(0);
    expect(tiltTarget(-178, 178, 3)).toBeCloseTo(tiltTarget(44, 40, 3));
  });

  it('refuses a reading that is not a number, and a strength outside 0 to the maximum', () => {
    expect(() => tiltTarget(Number.NaN, 40, 3)).toThrow(RangeError);
    expect(() => tiltTarget(40, 40, -1)).toThrow(RangeError);
    expect(() => tiltTarget(40, 40, MAX_TILT_STEPS + 1)).toThrow(RangeError);
  });
});

describe('tilt smoothing', () => {
  it('moves part of the way toward the target in one frame, and reaches it over time', () => {
    const one = smoothToward(0, 4, 16);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(1);
    expect(smoothToward(0, 4, TILT_SMOOTH_MS)).toBeCloseTo(4 * (1 - Math.exp(-1)));
    let value = 0;
    for (let frame = 0; frame < 120; frame++) value = smoothToward(value, 4, 16);
    expect(value).toBeCloseTo(4, 3);
  });

  it('stays put with no time, and never passes the target', () => {
    expect(smoothToward(1, 4, 0)).toBe(1);
    expect(smoothToward(1, -2, 10_000)).toBeCloseTo(-2);
    expect(smoothToward(1, -2, 10_000)).toBeGreaterThanOrEqual(-2);
    expect(() => smoothToward(0, 1, -1)).toThrow(RangeError);
  });
});

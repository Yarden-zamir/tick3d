import { describe, expect, it } from 'vitest';
import { TILT_DEAD_ZONE, TILT_FULL, TILT_SMOOTH_MS, smoothToward, tiltTarget } from './tilt.ts';

describe('tilt target', () => {
  it('gives no nudge inside the dead zone around neutral', () => {
    for (const beta of [40, 40 + TILT_DEAD_ZONE, 40 - TILT_DEAD_ZONE, 41.5, 38.5]) expect(tiltTarget(beta, 40, 4), String(beta)).toBe(0);
  });

  it('grows past the dead zone and stops at the full nudge', () => {
    const half = tiltTarget(40 + (TILT_DEAD_ZONE + TILT_FULL) / 2, 40, 4);
    expect(half).toBeCloseTo(2);
    expect(tiltTarget(40 + TILT_FULL, 40, 4)).toBeCloseTo(4);
    for (const beta of [40 + TILT_FULL + 5, 120, 179]) expect(tiltTarget(beta, 40, 4), String(beta)).toBe(4);
  });

  it('moves up for the top edge toward the player, and down for away', () => {
    expect(tiltTarget(48, 40, 4)).toBeGreaterThan(0);
    expect(tiltTarget(32, 40, 4)).toBeLessThan(0);
    expect(tiltTarget(32, 40, 4)).toBeCloseTo(-tiltTarget(48, 40, 4));
  });

  it('takes the short way around ±180°', () => {
    expect(tiltTarget(-178, 178, 4)).toBeGreaterThan(0);
    expect(tiltTarget(-178, 178, 4)).toBeCloseTo(tiltTarget(44, 40, 4));
  });

  it('refuses a reading that is not a number', () => {
    expect(() => tiltTarget(Number.NaN, 40, 4)).toThrow(RangeError);
    expect(() => tiltTarget(40, 40, -1)).toThrow(RangeError);
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

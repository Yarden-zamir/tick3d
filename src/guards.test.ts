import { describe, expect, it } from 'vitest';
import { isCount } from './guards.ts';

describe('isCount', () => {
  it('accepts whole numbers from 0 up to the largest safe integer', () => {
    expect(isCount(0)).toBe(true);
    expect(isCount(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '1', null])('refuses %s', (value) => {
    expect(isCount(value)).toBe(false);
  });
});

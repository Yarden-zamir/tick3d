import { describe, expect, it } from 'vitest';
import { createRing } from './ring.ts';

describe('audio ring', () => {
  it('keeps the newest samples in order, and gives copies', () => {
    const ring = createRing(5);
    expect(ring.last(3)).toHaveLength(0);
    ring.push(Float32Array.from([1, 2, 3]));
    expect([...ring.last(10)]).toEqual([1, 2, 3]);
    ring.push(Float32Array.from([4, 5, 6, 7]));
    expect([...ring.last(5)]).toEqual([3, 4, 5, 6, 7]);
    expect([...ring.last(2)]).toEqual([6, 7]);
    const copy = ring.last(2);
    ring.push(Float32Array.from([8]));
    expect([...copy]).toEqual([6, 7]);
  });

  it('keeps only the end of a push that is longer than the ring', () => {
    const ring = createRing(3);
    ring.push(Float32Array.from([1, 2, 3, 4, 5]));
    expect([...ring.last(3)]).toEqual([3, 4, 5]);
  });

  it('refuses a size or a count that is not a sample count', () => {
    expect(() => createRing(0)).toThrow(RangeError);
    expect(() => createRing(1.5)).toThrow(RangeError);
    const ring = createRing(3);
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => ring.last(count)).toThrow(RangeError);
  });
});

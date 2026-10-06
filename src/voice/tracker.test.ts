import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, positionOf } from './mapping.ts';
import { createTracker } from './tracker.ts';

const off = { share: 0, buildUpMs: 1000 };

describe('pitch tracker', () => {
  it('follows the median of the last frames, so one odd frame does not move the light', () => {
    const tracker = createTracker();
    for (const now of [0, 16, 32, 48]) tracker.feed(600, now, DEFAULT_RANGE, off);
    const odd = tracker.feed(1200, 64, DEFAULT_RANGE, off);
    expect(odd.kind === 'pitch' && odd.held.step).toBe(Math.floor(positionOf(600, DEFAULT_RANGE)));
  });

  it('keeps the light through a short gap, and puts it out after a longer one', () => {
    const tracker = createTracker();
    tracker.feed(600, 0, DEFAULT_RANGE, off);
    const kinds = Array.from({ length: 6 }, (_, i) => tracker.feed(null, 16 * (i + 1), DEFAULT_RANGE, off).kind);
    expect(kinds).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'silent']);
    // After the light went out, the next pitch starts fresh: no median from before.
    const next = tracker.feed(1200, 200, DEFAULT_RANGE, off);
    expect(next.kind === 'pitch' && next.frequency).toBe(1200);
  });
});

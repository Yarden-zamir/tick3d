import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, positionOf } from './mapping.ts';

const MAP = { range: DEFAULT_RANGE, spread: 'log' } as const;
import { createTracker } from './tracker.ts';

const off = { share: 0, buildUpMs: 1000 };

describe('pitch tracker', () => {
  it('follows the median of the last frames, so one odd frame does not move the light', () => {
    const tracker = createTracker();
    for (const now of [0, 16, 32, 48]) tracker.feed(600, now, MAP, off);
    const odd = tracker.feed(1200, 64, MAP, off);
    expect(odd.kind === 'pitch' && odd.held.step).toBe(Math.floor(positionOf(600, MAP)));
  });

  it('keeps the light through a short gap, and puts it out after a longer one', () => {
    const tracker = createTracker();
    tracker.feed(600, 0, MAP, off);
    const kinds = Array.from({ length: 6 }, (_, i) => tracker.feed(null, 16 * (i + 1), MAP, off).kind);
    expect(kinds).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'silent']);
    // After the light went out, the next pitch starts fresh: no median from before.
    const next = tracker.feed(1200, 200, MAP, off);
    expect(next.kind === 'pitch' && next.frequency).toBe(1200);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, positionOf } from './mapping.ts';

const MAP = { range: DEFAULT_RANGE, spread: 'log' } as const;
import { createTracker } from './tracker.ts';

const off = { share: 0, buildUpMs: 1000 };

describe('pitch tracker', () => {
  it('follows the median of the last frames, so one odd frame does not move the light', () => {
    const tracker = createTracker();
    for (const now of [0, 16, 32, 48]) tracker.feed(600, now, MAP, off, 0);
    const odd = tracker.feed(1200, 64, MAP, off, 0);
    expect(odd.kind === 'pitch' && odd.held.step).toBe(Math.floor(positionOf(600, MAP)));
  });

  it('keeps the light through a short gap, and puts it out after a longer one', () => {
    const tracker = createTracker();
    tracker.feed(600, 0, MAP, off, 0);
    const kinds = Array.from({ length: 6 }, (_, i) => tracker.feed(null, 16 * (i + 1), MAP, off, 0).kind);
    expect(kinds).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'silent']);
    // After the light went out, the next pitch starts fresh: no median from before.
    const next = tracker.feed(1200, 200, MAP, off, 0);
    expect(next.kind === 'pitch' && next.frequency).toBe(1200);
  });

  it('moves the place by the tilt nudge before the sticky cells, and keeps it inside the range', () => {
    const sticky = { share: 0.5, buildUpMs: 0 };
    const plain = createTracker().feed(600, 0, MAP, off, 0);
    const nudged = createTracker().feed(600, 0, MAP, off, 2);
    if (plain.kind !== 'pitch' || nudged.kind !== 'pitch') throw new Error('no pitch');
    expect(nudged.position).toBeCloseTo(plain.position + 2);
    expect(nudged.held.step).toBe(Math.floor(plain.position + 2));
    // The sticky margin holds the cell against a small change of the nudge, as against a wobble of the pitch.
    const tracker = createTracker();
    const first = tracker.feed(600, 0, MAP, sticky, 0.5 - (plain.position % 1));
    const wobble = tracker.feed(600, 16, MAP, sticky, 0.5 - (plain.position % 1) + 0.7);
    expect(first.kind === 'pitch' && wobble.kind === 'pitch' && wobble.held.step === first.held.step).toBe(true);
    // The edges hold.
    const top = createTracker().feed(2400, 0, MAP, off, 8);
    const bottom = createTracker().feed(150, 0, MAP, off, -8);
    expect(top.kind === 'pitch' && top.held.step).toBe(63);
    expect(bottom.kind === 'pitch' && bottom.position).toBe(0);
  });
});

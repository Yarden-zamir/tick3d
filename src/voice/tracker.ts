// From pitches to a held cell step: the median of the last frames, the light out after a short gap, and
// the sticky margin (sticky.ts). Both sound pages feed it one pitch per frame.
import { median } from './calibration.ts';
import { type PitchMap, positionOf } from './mapping.ts';
import { type Held, type Stickiness, holdStep, marginAt } from './sticky.ts';

// The median of the last frames moves the light, so one odd frame (a click, an octave jump) does not.
const SMOOTH_FRAMES = 5;
// After this many frames without a clear pitch (about 0.1 s), the light goes out.
const MISS_FRAMES = 6;

// `pitch`: a clear pitch, placed in the range. `gap`: no pitch in this frame, keep what shows. `silent`: no pitch
// for a while, put the light out.
type Tracked = { kind: 'pitch'; frequency: number; position: number; held: Held; margin: number } | { kind: 'gap' } | { kind: 'silent' };

export type Tracker = { feed(frequency: number | null, now: number, map: PitchMap, stickiness: Stickiness): Tracked; reset(): void };

export function createTracker(): Tracker {
  let recent: number[] = [];
  let misses = 0;
  let held: Held | null = null;
  const reset = () => {
    recent = [];
    misses = 0;
    held = null;
  };
  return {
    reset,
    feed(frequency, now, map, stickiness) {
      if (frequency === null) {
        misses++;
        if (misses < MISS_FRAMES) return { kind: 'gap' };
        reset();
        return { kind: 'silent' };
      }
      misses = 0;
      recent = [...recent, frequency].slice(-SMOOTH_FRAMES);
      const smooth = median(recent);
      const position = positionOf(smooth, map);
      held = holdStep(held, position, now, stickiness);
      return { kind: 'pitch', frequency: smooth, position, held, margin: marginAt(now - held.since, stickiness) };
    },
  };
}

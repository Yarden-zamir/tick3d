// From pitches to a held cell step: the median of the last frames, the light out after a short gap, and
// the sticky margin (sticky.ts). Both sound pages feed it one pitch per frame.
import { median } from './calibration.ts';
import { type PitchMap, STEPS, positionOf } from './mapping.ts';
import { type Held, type Stickiness, holdStep, marginAt } from './sticky.ts';

// The median of the last frames moves the light, so one odd frame (a click, an octave jump) does not.
const SMOOTH_FRAMES = 5;
// After this long without a clear pitch, the light goes out. It counts time and not frames: a slow page
// (a busy phone) has few frames, and a count of frames then held the light through a whole silence.
const MISS_MS = 100;

// `pitch`: a clear pitch, placed in the range. `gap`: no pitch in this frame, keep what shows. `silent`: no pitch
// for a while, put the light out.
type Tracked = { kind: 'pitch'; frequency: number; position: number; held: Held; margin: number } | { kind: 'gap' } | { kind: 'silent' };

// `nudge` moves the place of the pitch by that many steps (the tilt, tilt.ts), before the sticky cells, so the
// sticky logic sees the final place. The place stays inside the range.
export type Tracker = { feed(frequency: number | null, now: number, map: PitchMap, stickiness: Stickiness, nudge: number): Tracked; reset(): void };

export function createTracker(): Tracker {
  let recent: number[] = [];
  // The frame time of the first frame without a pitch, or null while the pitch goes on.
  let missSince: number | null = null;
  let held: Held | null = null;
  const reset = () => {
    recent = [];
    missSince = null;
    held = null;
  };
  return {
    reset,
    feed(frequency, now, map, stickiness, nudge) {
      if (frequency === null) {
        missSince ??= now;
        if (now - missSince < MISS_MS) return { kind: 'gap' };
        reset();
        return { kind: 'silent' };
      }
      missSince = null;
      recent = [...recent, frequency].slice(-SMOOTH_FRAMES);
      const smooth = median(recent);
      if (!Number.isFinite(nudge)) throw new RangeError(`not a nudge: ${nudge}`);
      const position = Math.min(STEPS - 1e-9, Math.max(0, positionOf(smooth, map) + nudge));
      held = holdStep(held, position, now, stickiness);
      return { kind: 'pitch', frequency: smooth, position, held, margin: marginAt(now - held.since, stickiness) };
    },
  };
}

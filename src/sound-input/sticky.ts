// Sticky cells: hysteresis at the cell borders. The lit cell holds until the pitch moves past its border by
// a margin. The margin starts at zero when a cell lights, and grows while the player holds that cell, up to
// a maximum. So a new cell answers at once, and a held cell gets protection after the player did the work.

// `share` is the largest margin, as a share of one cell (0 is off, 1 is one whole cell on each side).
// `buildUpMs` is the hold time that it takes to reach that margin.
export type Stickiness = { share: number; buildUpMs: number };

export const DEFAULT_STICKINESS: Stickiness = { share: 0.5, buildUpMs: 1500 };
export const MAX_SHARE = 1;
export const MAX_BUILD_UP_MS = 5000;

// The step that holds the light, and the time when it started to hold it.
export type Held = { step: number; since: number };

// The margin in steps (cells) after `heldMs` of holding.
export function marginAt(heldMs: number, { share, buildUpMs }: Stickiness): number {
  if (share <= 0) return 0;
  if (buildUpMs <= 0) return share;
  return share * Math.min(1, Math.max(0, heldMs / buildUpMs));
}

// The step for the pitch at `position` (see positionOf in mapping.ts). null starts fresh: no light before.
export function holdStep(held: Held | null, position: number, now: number, stickiness: Stickiness): Held {
  if (!Number.isFinite(position) || position < 0) throw new RangeError(`not a position: ${position}`);
  const step = Math.floor(position);
  if (held === null || held.step === step) return held ?? { step, since: now };
  const margin = marginAt(now - held.since, stickiness);
  if (position >= held.step - margin && position < held.step + 1 + margin) return held;
  return { step, since: now };
}

// The player's own pitch range for /sound-input. The calibration takes the median pitch of the lowest
// and of the highest sound of the player.
import type { Range } from './mapping.ts';
import { MAX_FREQUENCY, MIN_FREQUENCY } from './pitch.ts';

// A calibrated or typed range needs half an octave at least. A smaller range puts the 64 cells too close together.
const MIN_RATIO = Math.SQRT2;

// Under one octave, the four rows sit close together, so the page shows a hint. The range still works.
export const isSmallRange = ({ low, high }: Range): boolean => high / low < 2;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new RangeError('no values for a median');
  return middle;
}

// Why the player must try again: a step had no clear pitch, the high sound was not above the low sound,
// or the two sounds were less than half an octave apart.
export type Retry = 'silent' | 'order' | 'narrow';

export function rangeFrom(lows: readonly number[], highs: readonly number[]): Range | Retry {
  if (lows.length === 0 || highs.length === 0) return 'silent';
  const low = median(lows);
  const high = median(highs);
  if (!(low > 0) || !(high > low)) return 'order';
  if (high / low < MIN_RATIO) return 'narrow';
  return { low, high };
}

// A range that the player typed or took from two sung notes. A string says what is wrong with it.
export function typedRange(low: number, high: number): Range | string {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'Type a number of Hz for both ends.';
  // A typed range stays inside the pitches that the detector finds.
  if (low < MIN_FREQUENCY || high > MAX_FREQUENCY) return `The range stays from ${MIN_FREQUENCY} to ${MAX_FREQUENCY} Hz.`;
  if (!(high > low)) return 'The high end must be above the low end.';
  if (high / low < MIN_RATIO) return 'The range needs half an octave at least: the high end at 1.42 times the low end.';
  return { low, high };
}

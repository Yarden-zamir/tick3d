// The player's own pitch range for /sound-input. The calibration takes the median pitch of the lowest
// and of the highest sound of the player. The device keeps the range in localStorage.

export type Range = { low: number; high: number };

export const STORAGE_KEY = 'tick3d.sound-input';
const STORAGE_VERSION = 1;

// Under one octave, the four rows sit close together, so the page shows a hint. The range still works.
export const isSmallRange = ({ low, high }: Range): boolean => high / low < 2;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new RangeError('no values for a median');
  return middle;
}

const isFrequency = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

// The range from the pitches of the two steps. null means "retry": a step has no clear pitch, or the
// low sound is at or above the high sound.
export function rangeFrom(lows: readonly number[], highs: readonly number[]): Range | null {
  if (lows.length === 0 || highs.length === 0) return null;
  const low = median(lows);
  const high = median(highs);
  return isFrequency(low) && isFrequency(high) && low < high ? { low, high } : null;
}

export const storedRange = ({ low, high }: Range) => ({ version: STORAGE_VERSION, low, high });

// A stored value comes from an older visit or a hand edit. Anything other than a valid range of this
// version means "not calibrated".
export function parseRange(stored: unknown): Range | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const { version, low, high } = stored as Record<string, unknown>;
  if (version !== STORAGE_VERSION || !isFrequency(low) || !isFrequency(high) || low >= high) return null;
  return { low, high };
}

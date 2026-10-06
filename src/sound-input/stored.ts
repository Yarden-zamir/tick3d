// The choices of /sound-input that the device keeps in localStorage: the calibrated range and the
// stickiness. A stored value comes from an older visit or a hand edit, so each field is checked, and a bad
// field takes its default.
import type { Range } from './mapping.ts';
import { DEFAULT_STICKINESS, MAX_BUILD_UP_MS, MAX_SHARE, type Stickiness } from './sticky.ts';

export const STORAGE_KEY = 'tick3d.sound-input';
const STORAGE_VERSION = 1;

// `range` is null when the player did not calibrate: the page uses DEFAULT_RANGE then.
export type Stored = { range: Range | null; stickiness: Stickiness };

export const DEFAULT_STORED: Stored = { range: null, stickiness: DEFAULT_STICKINESS };

const isFrequency = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const inRange = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

export const toStorage = ({ range, stickiness }: Stored) => ({ version: STORAGE_VERSION, range, stickiness });

function parseRange(value: unknown): Range | null {
  if (typeof value !== 'object' || value === null) return null;
  const { low, high } = value as Record<string, unknown>;
  return isFrequency(low) && isFrequency(high) && low < high ? { low, high } : null;
}

function parseStickiness(value: unknown): Stickiness {
  if (typeof value !== 'object' || value === null) return DEFAULT_STICKINESS;
  const { share, buildUpMs } = value as Record<string, unknown>;
  return {
    share: inRange(share, MAX_SHARE) ? share : DEFAULT_STICKINESS.share,
    buildUpMs: inRange(buildUpMs, MAX_BUILD_UP_MS) ? buildUpMs : DEFAULT_STICKINESS.buildUpMs,
  };
}

export function parseStored(value: unknown): Stored {
  if (typeof value !== 'object' || value === null) return DEFAULT_STORED;
  const { version, range, stickiness } = value as Record<string, unknown>;
  if (version !== STORAGE_VERSION) return DEFAULT_STORED;
  return { range: parseRange(range), stickiness: parseStickiness(stickiness) };
}

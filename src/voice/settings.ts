// The voice settings that the device keeps in localStorage: the calibrated range and the stickiness.
// The Voice room (/sound-input) changes them, and every page that listens to the voice reads them.
// A stored value comes from an older visit or a hand edit, so each field is checked, and a bad field
// takes its default.
import { type Range, SPREADS, type Spread } from './mapping.ts';
import { DEFAULT_STICKINESS, MAX_BUILD_UP_MS, MAX_SHARE, type Stickiness } from './sticky.ts';

const STORAGE_KEY = 'tick3d.voice';
const STORAGE_VERSION = 1;

// `range` is null when the player did not calibrate: the page uses DEFAULT_RANGE then.
// `spread` says how the 64 cells share the range (SPREADS in mapping.ts).
export type VoiceSettings = { range: Range | null; spread: Spread; stickiness: Stickiness };

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { range: null, spread: 'log', stickiness: DEFAULT_STICKINESS };

const isFrequency = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const inRange = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

export const toStorage = ({ range, spread, stickiness }: VoiceSettings) => ({ version: STORAGE_VERSION, range, spread, stickiness });

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

export function parseVoiceSettings(value: unknown): VoiceSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_VOICE_SETTINGS;
  const { version, range, spread, stickiness } = value as Record<string, unknown>;
  if (version !== STORAGE_VERSION) return DEFAULT_VOICE_SETTINGS;
  return { range: parseRange(range), spread: SPREADS.find((known) => known === spread) ?? DEFAULT_VOICE_SETTINGS.spread, stickiness: parseStickiness(stickiness) };
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    return parseVoiceSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStorage(settings)));
  } catch {
    // Private mode or a full storage: the choices still work for this visit.
  }
}

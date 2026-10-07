import { describe, expect, it } from 'vitest';
import { DEFAULT_STICKINESS } from './sticky.ts';
import { DEFAULT_VOICE_SETTINGS, parseVoiceSettings, toStorage } from './settings.ts';
import { DEFAULT_TILT } from './tilt.ts';

describe('voice settings', () => {
  it('reads back what it stores', () => {
    const stored = { range: { low: 210, high: 1350 }, spread: 'middle' as const, stickiness: { share: 0.3, buildUpMs: 2500 }, tilt: { on: false, steps: 6 } };
    expect(parseVoiceSettings(JSON.parse(JSON.stringify(toStorage(stored))))).toEqual(stored);
    expect(parseVoiceSettings(JSON.parse(JSON.stringify(toStorage(DEFAULT_VOICE_SETTINGS))))).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it('treats a missing or wrong version as nothing stored', () => {
    for (const bad of [null, 'x', 42, {}, { range: { low: 210, high: 1350 } }, { version: 2, range: { low: 210, high: 1350 } }]) {
      expect(parseVoiceSettings(bad), JSON.stringify(bad)).toEqual(DEFAULT_VOICE_SETTINGS);
    }
  });

  it('gives a bad field its default and keeps the good fields', () => {
    const stickiness = { share: 0.2, buildUpMs: 800 };
    for (const range of [{ low: 1350, high: 210 }, { low: -1, high: 300 }, { low: 210, high: '1350' }, { low: 210, high: Infinity }, 'x']) {
      expect(parseVoiceSettings({ version: 1, range, spread: 'linear', stickiness }), JSON.stringify(range)).toEqual({ range: null, spread: 'linear', stickiness, tilt: DEFAULT_TILT });
    }
    for (const spread of ['zigzag', 3, undefined]) {
      expect(parseVoiceSettings({ version: 1, range: null, spread, stickiness }).spread).toBe('log');
    }
    for (const bad of [{ share: 2, buildUpMs: 800 }, { share: -0.1, buildUpMs: 800 }, { share: 0.2, buildUpMs: 60_000 }, { share: '0.2', buildUpMs: 800 }]) {
      const parsed = parseVoiceSettings({ version: 1, range: null, stickiness: bad });
      expect(parsed.stickiness.share === DEFAULT_STICKINESS.share || parsed.stickiness.buildUpMs === DEFAULT_STICKINESS.buildUpMs, JSON.stringify(bad)).toBe(true);
    }
  });

  it('gives the tilt its default when a store from before the tilt has none, or a bad one', () => {
    const before = { version: 1, range: null, spread: 'log', stickiness: DEFAULT_STICKINESS };
    expect(parseVoiceSettings(before).tilt).toEqual(DEFAULT_TILT);
    for (const tilt of ['x', { on: 'yes', steps: 3 }, { on: false, steps: 0 }, { on: false, steps: 99 }]) {
      const parsed = parseVoiceSettings({ ...before, tilt }).tilt;
      expect(parsed.on === DEFAULT_TILT.on || parsed.steps === DEFAULT_TILT.steps, JSON.stringify(tilt)).toBe(true);
    }
  });
});

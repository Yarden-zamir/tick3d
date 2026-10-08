import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, deviceDataKeys } from './storage-keys.ts';
import { DEFAULT_VOICE_SETTINGS, saveVoiceSettings } from './voice/settings.ts';

afterEach(() => vi.unstubAllGlobals());

describe('delete my data on this device', () => {
  const keys = [...Object.values(STORAGE_KEYS), 'tick3d.voice', 'tick3d.voice-practice', 'other-site.key'];

  it('removes the game data, keeps the player token and the settings, and leaves other keys alone', () => {
    const removed = deviceDataKeys(keys, false);
    expect(removed).toEqual(expect.arrayContaining([STORAGE_KEYS.records, STORAGE_KEYS.name, STORAGE_KEYS.blocks, STORAGE_KEYS.reported, STORAGE_KEYS.soundTraining, 'tick3d.voice-practice']));
    for (const kept of [STORAGE_KEYS.player, STORAGE_KEYS.settings, STORAGE_KEYS.tuning, 'tick3d.voice', 'other-site.key']) expect(removed).not.toContain(kept);
  });

  it('also removes the settings when the player asks, but never the player token', () => {
    const removed = deviceDataKeys(keys, true);
    expect(removed).toEqual(expect.arrayContaining([STORAGE_KEYS.settings, STORAGE_KEYS.tuning, 'tick3d.voice']));
    expect(removed).not.toContain(STORAGE_KEYS.player);
  });

  it('knows the key that the voice settings use', () => {
    const written: string[] = [];
    vi.stubGlobal('localStorage', { setItem: (key: string) => written.push(key) });
    saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
    expect(written).toHaveLength(1);
    expect(deviceDataKeys(written, false)).toEqual([]);
    expect(deviceDataKeys(written, true)).toEqual(written);
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../storage-keys.ts';

// The settings load once, when the module loads, so each case loads a fresh copy.
async function loadWith(stored: unknown): Promise<typeof import('./settings.ts')> {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(stored));
  return import('./settings.ts');
}

describe('the sound set setting', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('keeps a known set', async () => {
    expect((await loadWith({ soundSet: 'gamelan' })).settings.soundSet).toBe('gamelan');
  });

  it('falls back to the default set for an unknown, missing or wrong value', async () => {
    for (const stored of [{ soundSet: 'kazoo' }, {}, { soundSet: 3 }, null]) {
      vi.resetModules();
      const { settings, DEFAULTS } = await loadWith(stored);
      expect(settings.soundSet).toBe(DEFAULTS.soundSet);
    }
  });
});

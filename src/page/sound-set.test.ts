// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundSetId } from '../sound-sets.ts';

// The settings load once, when the module loads, so each case loads fresh modules.
async function menuWith(soundSet: string): Promise<{ list: HTMLElement; used: SoundSetId[] }> {
  localStorage.setItem('tick3d.settings', JSON.stringify({ soundSet }));
  const { setupSoundSets } = await import('./sound-set.ts');
  const list = document.createElement('div');
  const used: SoundSetId[] = [];
  setupSoundSets(list, (id) => used.push(id));
  return { list, used };
}

const pressed = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[aria-pressed="true"]')].map((button) => button.dataset.soundSet);

describe('the sound set menu', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('uses the stored set at the start and marks it', async () => {
    const { list, used } = await menuWith('gamelan');
    expect(used).toEqual(['gamelan']);
    expect(pressed(list)).toEqual(['gamelan']);
  });

  it('saves a choice, uses it, and moves the mark', async () => {
    const { list, used } = await menuWith('cells');
    list.querySelector<HTMLButtonElement>('[data-sound-set="choir"]')?.click();
    expect(used).toEqual(['cells', 'choir']);
    expect(pressed(list)).toEqual(['choir']);
    expect(JSON.parse(localStorage.getItem('tick3d.settings') ?? 'null')).toMatchObject({ soundSet: 'choir' });
  });
});

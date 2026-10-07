// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { avatarFor, avatarSvg } from './avatar.ts';

describe('generated player pictures', () => {
  it('gives one seed the same picture every time', () => {
    expect(avatarSvg('braveOtter')).toBe(avatarSvg('braveOtter'));
  });

  it('gives different seeds different pictures', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `player${i}`);
    expect(new Set(seeds.map(avatarSvg)).size).toBe(seeds.length);
  });

  it('refuses an empty seed', () => {
    expect(() => avatarSvg('')).toThrow();
  });

  it('draws the generated picture on the page without a network request', () => {
    const image = avatarFor({ player: null, name: 'braveOtter' }, 24);
    expect(image.src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(image.src.slice('data:image/svg+xml,'.length))).toBe(avatarSvg('braveOtter'));
    expect(image.alt).toBe('');
  });

  it('shows the GitHub avatar of a logged-in player', () => {
    const player = { login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4' };
    const image = avatarFor({ player, name: 'octocat' }, 24);
    expect(image.src.startsWith(player.avatar)).toBe(true);
  });
});

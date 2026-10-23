// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { avatarFor, avatarImage, avatarSvg, hiddenLogin, viewablePerson } from './avatar.ts';

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
    const image = avatarFor({ player: null, name: 'braveOtter' }, 24, null);
    expect(image.src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(image.src.slice('data:image/svg+xml,'.length))).toBe(avatarSvg('braveOtter'));
  });

  it('makes the picture a button that names the person', () => {
    const image = avatarFor({ player: null, name: 'braveOtter' }, 24, null);
    expect(image.getAttribute('role')).toBe('button');
    expect(image.tabIndex).toBe(0);
    expect(image.getAttribute('aria-label')).toBe("View braveOtter's picture");
    expect(viewablePerson(image)).toEqual({ person: { player: null, name: 'braveOtter' }, id: null });
    expect(viewablePerson(avatarImage({ player: null, name: 'braveOtter' }, 24))).toBeUndefined();
  });

  it('shows the GitHub avatar of a logged-in player', () => {
    const player = { provider: 'github' as const, login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4', name: null, seed: null };
    const image = avatarFor({ player, name: 'octocat' }, 24, null);
    expect(image.src.startsWith(player.avatar)).toBe(true);
  });

  it('shows the Google photo of a Google account at twice the size, and a generated picture without a photo', () => {
    const player = { provider: 'google' as const, login: 'Dana Levi', avatar: 'https://lh3.googleusercontent.com/a/abc', name: null, seed: null };
    expect(avatarImage({ player, name: 'Dana Levi' }, 24).src).toBe('https://lh3.googleusercontent.com/a/abc=s48-c');
    expect(avatarImage({ player: { ...player, avatar: null }, name: 'Dana Levi' }, 24).src).toBe(`data:image/svg+xml,${encodeURIComponent(avatarSvg('Dana Levi'))}`);
  });

  it('shows the GitHub login of a renamed GitHub account, and never the Google name', () => {
    const github = { provider: 'github' as const, login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/1?v=4', name: 'Dana', seed: null };
    expect(hiddenLogin({ player: github, name: 'Dana' })).toBe('octocat');
    expect(hiddenLogin({ player: { ...github, provider: 'google', login: 'Dana Levi', avatar: null }, name: 'Dana' })).toBeNull();
  });

  it('shows the generated picture that an account chose, from its seed and not its name', () => {
    const player = { provider: 'github' as const, login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4', name: 'Dana', seed: '0123456789ab' };
    expect(avatarImage({ player, name: 'Dana' }, 24).src).toBe(`data:image/svg+xml,${encodeURIComponent(avatarSvg('0123456789ab'))}`);
  });
});

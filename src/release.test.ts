import { describe, expect, it } from 'vitest';
import { MAX_RELEASE_NAME, parseRelease, releaseLabel, releaseName, versionOfScript } from './release.ts';

const merge = { parents: 2, subject: 'Merge pull request #115 from Yarden-zamir/fix/draw-before-server', body: '\nfix(ui): draw online controls grey before the server answers\n' };

describe('releaseName', () => {
  it('takes the pull request title from a GitHub merge commit', () => {
    expect(releaseName(merge, 'prod')).toBe('fix(ui): draw online controls grey before the server answers');
  });

  it('takes the subject of a direct push, and of a merge without a body', () => {
    expect(releaseName({ parents: 1, subject: 'docs: trim the README', body: '' }, 'prod')).toBe('docs: trim the README');
    expect(releaseName({ ...merge, body: '' }, 'prod')).toBe(merge.subject);
    expect(releaseName({ ...merge, parents: 1 }, undefined)).toBe(merge.subject);
  });

  it('marks a preview with its environment', () => {
    expect(releaseName({ parents: 1, subject: 'feat(stats): show release names', body: '' }, 'pr-116')).toBe('feat(stats): show release names (pr-116)');
  });

  it('caps the length and refuses a commit without a subject', () => {
    expect(releaseName({ parents: 1, subject: 'x'.repeat(300), body: '' }, 'prod')).toHaveLength(MAX_RELEASE_NAME);
    expect(() => releaseName({ parents: 1, subject: ' ', body: '' }, 'prod')).toThrow();
  });
});

describe('parseRelease', () => {
  const valid = { version: 'main-B2x9kQ', name: 'feat: x', at: 1_700_000_000_000 };

  it('accepts a release file', () => {
    expect(parseRelease(valid)).toEqual(valid);
  });

  it.each([
    ['not an object', 'main-B2x9kQ'],
    ['a bad version', { ...valid, version: '<script>' }],
    ['an empty name', { ...valid, name: '' }],
    ['a long name', { ...valid, name: 'x'.repeat(MAX_RELEASE_NAME + 1) }],
    ['a time in seconds as text', { ...valid, at: '1700000000' }],
    ['no time', { version: valid.version, name: valid.name }],
  ])('refuses %s', (_, value) => {
    expect(() => parseRelease(value)).toThrow();
  });
});

describe('versionOfScript', () => {
  it('gives the same version for the built file name and the page script URL', () => {
    expect(versionOfScript('assets/main-B-1gqizD.js')).toBe('main-B-1gqizD');
    expect(versionOfScript('/assets/main-B-1gqizD.js')).toBe('main-B-1gqizD');
  });
});

describe('releaseLabel', () => {
  it('shows the name, or the hash of an unknown version', () => {
    expect(releaseLabel({ version: 'main-abc', name: 'feat: x' })).toBe('feat: x');
    expect(releaseLabel({ version: 'main-abc', name: null })).toBe('Unknown (main-abc)');
  });
});

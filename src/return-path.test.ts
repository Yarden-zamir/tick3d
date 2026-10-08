import { describe, expect, it } from 'vitest';
import { readReturn, withReturn } from './return-path.ts';

const SITE = 'https://tick3d.example.com';

describe('the return parameter', () => {
  it('returns to the path that a link carries, on the same site', () => {
    const href = withReturn('/sound-input?code=ABCD', '/?code=ABCD&x=1');
    const url = new URL(href, SITE);
    expect(url.pathname).toBe('/sound-input');
    expect(url.searchParams.get('code')).toBe('ABCD');
    expect(readReturn(url)).toBe(`${SITE}/?code=ABCD&x=1`);
  });

  it('never returns to another site, and holds no return without the parameter', () => {
    for (const value of ['//evil.example.com/x', 'https://evil.example.com/', 'stats', '/\\evil.example.com', '']) {
      expect(readReturn(new URL(`/sound-input?${new URLSearchParams({ return: value })}`, SITE))).toBeUndefined();
    }
    expect(readReturn(new URL('/sound-input', SITE))).toBeUndefined();
  });
});

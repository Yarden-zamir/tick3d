import { describe, expect, it } from 'vitest';
import type { Code } from './protocol.ts';
import { readLinkIntent, sessionLink, withWatch } from './session-link.ts';

const SITE = 'https://tick3d.example.com';
const CODE = 'AB3K' as Code;

describe('the session link', () => {
  it('reads back the intent that it holds', () => {
    for (const intent of ['play', 'watch'] as const) {
      const url = new URL(sessionLink(SITE, CODE, intent));
      expect(url.searchParams.get('code')).toBe(CODE);
      expect(readLinkIntent(url.searchParams)).toBe(intent);
    }
  });

  it('accepts only one watch=1', () => {
    for (const query of ['watch=0', 'watch=true', 'watch=', 'watch', 'watch=1&watch=1', 'watch=1&watch=0', 'watch=%201']) {
      expect(readLinkIntent(new URLSearchParams(`code=AB3K&${query}`)), query).toBe('invalid');
    }
  });

  it('sets and drops only the watch value in an address', () => {
    const url = new URL(`${SITE}/?code=AB3K&watch=yes&game=x`);
    expect(withWatch(url, true).search).toBe('?code=AB3K&game=x&watch=1');
    expect(withWatch(url, false).search).toBe('?code=AB3K&game=x');
  });
});

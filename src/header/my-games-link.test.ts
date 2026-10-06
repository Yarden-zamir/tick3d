import { describe, expect, it } from 'vitest';
import { myGamesHref, readMyGamesRequest, withoutMyGamesRequest } from './my-games-link.ts';

const SITE = 'https://tick3d.example.com';

describe('the My games link', () => {
  it('opens My games and returns to the page that links to it', () => {
    const url = new URL(myGamesHref('/stats?x=1'), SITE);
    expect(url.pathname).toBe('/');
    expect(readMyGamesRequest(url)).toEqual({ returnTo: `${SITE}/stats?x=1` });
  });

  it('holds no request in an address without the flag', () => {
    expect(readMyGamesRequest(new URL('/?code=ABCD', SITE))).toBeUndefined();
    expect(readMyGamesRequest(new URL('/?open=other&return=/stats', SITE))).toBeUndefined();
  });

  it('never returns to another site', () => {
    for (const value of ['//evil.example.com/x', 'https://evil.example.com/', 'stats', '/\\evil.example.com']) {
      const url = new URL(`/?${new URLSearchParams({ open: 'my-games', return: value })}`, SITE);
      expect(readMyGamesRequest(url)).toEqual({ returnTo: undefined });
    }
    expect(readMyGamesRequest(new URL('/?open=my-games', SITE))).toEqual({ returnTo: undefined });
  });

  it('drops only the request from the address', () => {
    const url = new URL(myGamesHref('/stats'), SITE);
    url.searchParams.set('code', 'ABCD');
    expect(withoutMyGamesRequest(url).search).toBe('?code=ABCD');
  });
});

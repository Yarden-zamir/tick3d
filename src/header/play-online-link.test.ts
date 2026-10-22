import { describe, expect, it } from 'vitest';
import { PLAY_ONLINE_HREF, takePlayOnlineRequest } from './play-online-link.ts';

const SITE = 'https://tick3d.example';

describe('the play online request', () => {
  it('is found in its own link, and the clean address keeps the rest', () => {
    const url = new URL(PLAY_ONLINE_HREF, SITE);
    url.searchParams.set('theme', 'dark');
    expect(takePlayOnlineRequest(url)?.href).toBe(`${SITE}/?theme=dark`);
  });

  it('is not found in other addresses', () => {
    expect(takePlayOnlineRequest(new URL('/?open=my-games', SITE))).toBeUndefined();
    expect(takePlayOnlineRequest(new URL('/', SITE))).toBeUndefined();
  });
});

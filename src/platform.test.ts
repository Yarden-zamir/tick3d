import { describe, expect, it } from 'vitest';
import { platformOf } from './platform.ts';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('platformOf', () => {
  it('finds the iOS app by the marker that it adds to the user agent', () => {
    expect(platformOf(`${SAFARI} tick3dApp/ios`)).toBe('ios');
  });

  it('reads Safari, Chrome and the Android app as the web', () => {
    expect(platformOf(SAFARI)).toBe('web');
    expect(platformOf('Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toBe('web');
    expect(platformOf(`${SAFARI} tick3dApp/iosx`)).toBe('web');
  });
});

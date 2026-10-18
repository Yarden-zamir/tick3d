import { describe, expect, it } from 'vitest';
import { isAndroidAppReferrer, platformOf } from './platform.ts';

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

describe('isAndroidAppReferrer', () => {
  it('finds the launch of the Android app by the package id of android/twa-manifest.json', () => {
    expect(isAndroidAppReferrer('android-app://com.yardenzamir.tick3d')).toBe(true);
    expect(isAndroidAppReferrer('android-app://com.yardenzamir.tick3d/')).toBe(true);
  });

  it.each(['', 'https://tick3d.yarden-zamir.com/testing', 'android-app://com.yardenzamir.tick3d.other', 'android-app://com.android.chrome/'])('reads %o as no app', (referrer) => {
    expect(isAndroidAppReferrer(referrer)).toBe(false);
  });
});

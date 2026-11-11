import { describe, expect, it } from 'vitest';
import { type AppVisitor, type PlatformSignals, appleOf, offersPlayApp, platformOf } from './platform.ts';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const BROWSER: PlatformSignals = { userAgent: CHROME_ANDROID, referrer: '', search: '', androidInSession: false };

describe('platformOf', () => {
  it('finds the iOS app by the marker that it adds to the user agent', () => {
    expect(platformOf({ ...BROWSER, userAgent: `${SAFARI} tick3dApp/ios` })).toBe('ios');
  });

  it('finds the Android app by the address or the referrer of its first page, or by the marker of the tab session', () => {
    expect(platformOf({ ...BROWSER, search: '?playPurchase=1&code=AB3K' })).toBe('android');
    expect(platformOf({ ...BROWSER, referrer: 'android-app://com.yardenzamir.tick3d/' })).toBe('android');
    expect(platformOf({ ...BROWSER, referrer: 'android-app://com.yardenzamir.tick3d' })).toBe('android');
    expect(platformOf({ ...BROWSER, referrer: 'https://tick3d.yarden-zamir.com/', androidInSession: true })).toBe('android');
  });

  it('reads Safari, Chrome and other Android apps as the web', () => {
    expect(platformOf({ ...BROWSER, userAgent: SAFARI })).toBe('web');
    expect(platformOf(BROWSER)).toBe('web');
    expect(platformOf({ ...BROWSER, userAgent: `${SAFARI} tick3dApp/iosx` })).toBe('web');
    expect(platformOf({ ...BROWSER, referrer: 'android-app://com.yardenzamir.tick3dx/' })).toBe('web');
    expect(platformOf({ ...BROWSER, referrer: 'android-app://com.google.android.gm/' })).toBe('web');
    expect(platformOf({ ...BROWSER, search: '?playPurchase=0' })).toBe('web');
  });
});

describe('appleOf', () => {
  it('finds an iPhone, and an iPad that names a Mac, but not a Mac', () => {
    expect(appleOf(SAFARI, 5)).toBe(true);
    expect(appleOf(IPAD, 5)).toBe(true);
    expect(appleOf(IPAD, 0)).toBe(false);
    expect(appleOf(CHROME_ANDROID, 5)).toBe(false);
  });
});

describe('offersPlayApp', () => {
  const visitor: AppVisitor = { platform: 'web', apple: false, installed: false };

  it('offers the Android app to a browser on Android or on a computer while the listing is live', () => {
    expect(offersPlayApp(visitor, 'live')).toBe(true);
  });

  it('never offers it inside an app, on an iPhone or an iPad, or in an installed web app', () => {
    expect(offersPlayApp({ ...visitor, platform: 'android' }, 'live')).toBe(false);
    expect(offersPlayApp({ ...visitor, platform: 'ios' }, 'live')).toBe(false);
    expect(offersPlayApp({ ...visitor, apple: true }, 'live')).toBe(false);
    expect(offersPlayApp({ ...visitor, installed: true }, 'live')).toBe(false);
  });

  it('does not offer it while the app is in the closed test or the server is out of reach', () => {
    expect(offersPlayApp(visitor, 'testing')).toBe(false);
    expect(offersPlayApp(visitor, undefined)).toBe(false);
  });
});

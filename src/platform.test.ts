import { describe, expect, it } from 'vitest';
import { type AppVisitor, type PlatformSignals, appOffer, appleOf, platformOf } from './platform.ts';
import type { Stores } from './protocol.ts';

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

describe('appOffer', () => {
  const computer: AppVisitor = { platform: 'web', apple: false, installed: false };
  const iphone: AppVisitor = { ...computer, apple: true };
  const live: Stores = { play: 'live', apple: 'live' };

  it('offers Google Play on Android or a computer, and the App Store on an iPhone or an iPad', () => {
    expect(appOffer(computer, live)).toBe('play');
    expect(appOffer(iphone, live)).toBe('app-store');
  });

  it('never offers an app inside an app or in an installed web app', () => {
    for (const visitor of [computer, iphone]) {
      expect(appOffer({ ...visitor, platform: 'android' }, live)).toBeUndefined();
      expect(appOffer({ ...visitor, platform: 'ios' }, live)).toBeUndefined();
      expect(appOffer({ ...visitor, installed: true }, live)).toBeUndefined();
    }
  });

  it('offers a store only while its own app is live', () => {
    expect(appOffer(computer, { play: 'testing', apple: 'live' })).toBeUndefined();
    expect(appOffer(iphone, { play: 'live', apple: 'testing' })).toBeUndefined();
    expect(appOffer(iphone, { play: 'live' })).toBeUndefined();
    expect(appOffer(computer, undefined)).toBeUndefined();
    expect(appOffer(iphone, undefined)).toBeUndefined();
  });
});

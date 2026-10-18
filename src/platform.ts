import twaManifest from '../android/twa-manifest.json' with { type: 'json' };

// Where the page runs: a browser, or the iOS app. The iOS app (apple/capacitor.config.json) loads this
// same site and adds "tick3dApp/ios" to the user agent. The page marks <html data-platform>, so the CSS
// hides what the App Store does not allow ([data-hide-in~="ios"] in src/style.css) with no second build.
export type Platform = 'web' | 'ios';

export const platformOf = (userAgent: string): Platform => (/\btick3dApp\/ios\b/.test(userAgent) ? 'ios' : 'web');

export const platform = (): Platform => platformOf(navigator.userAgent);

export function markPlatform(): void {
  document.documentElement.dataset.platform = platform();
}

// The Android app is a Trusted Web Activity (android/twa-manifest.json) in Chrome: the user agent is the one of
// Chrome, so the page tells the app by the referrer of its launch, android-app://<package id>. That needs no new
// app build. Only the first page load of a launch has that referrer, so the session keeps the fact.
// The Android app counts as a 'web' platform: it may show all that the site shows.
const ANDROID_APP_REFERRER = `android-app://${twaManifest.packageId}`;
const ANDROID_APP_SESSION_KEY = 'tick3d.android-app';

export const isAndroidAppReferrer = (referrer: string): boolean => referrer === ANDROID_APP_REFERRER || referrer.startsWith(`${ANDROID_APP_REFERRER}/`);

export function isAndroidApp(): boolean {
  try {
    if (isAndroidAppReferrer(document.referrer)) sessionStorage.setItem(ANDROID_APP_SESSION_KEY, '1');
    return sessionStorage.getItem(ANDROID_APP_SESSION_KEY) === '1';
  } catch {
    // Storage is blocked: only the launch page knows.
    return isAndroidAppReferrer(document.referrer);
  }
}

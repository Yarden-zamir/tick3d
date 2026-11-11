// Where the page runs: a browser, the iOS app or the Android app. Both apps load this same site, so the page
// marks <html data-platform>. The CSS then hides what the App Store does not allow ([data-hide-in~="ios"] in
// src/style.css) with no second build.
// - The iOS app (apple/capacitor.config.json) adds "tick3dApp/ios" to the user agent.
// - The Android app (android/twa-manifest.json) is a Trusted Web Activity with the user agent of Chrome. Its first page
//   has two marks: the address holds "playPurchase=1" (PurchaseActivity.java, every build since 0.12), and Chrome
//   gives the referrer "android-app://com.yardenzamir.tick3d/". The next page has neither, so the page keeps a marker
//   in sessionStorage. The app has its own Chrome tab, so the marker never reaches the Chrome browser.
import type { PlayStage } from './protocol.ts';

export type Platform = 'web' | 'ios' | 'android';

const ANDROID_APP_REFERRER = 'android-app://com.yardenzamir.tick3d';
const ANDROID_SESSION_KEY = 'tick3d.android-app';

export type PlatformSignals = {
  userAgent: string;
  referrer: string;
  // The query string of the address, for example "?playPurchase=1".
  search: string;
  // True when an earlier page of this tab saw the referrer of the Android app.
  androidInSession: boolean;
};

export function platformOf({ userAgent, referrer, search, androidInSession }: PlatformSignals): Platform {
  if (/\btick3dApp\/ios\b/.test(userAgent)) return 'ios';
  const launched = new URLSearchParams(search).get('playPurchase') === '1';
  if (launched || androidInSession || referrer === ANDROID_APP_REFERRER || referrer.startsWith(`${ANDROID_APP_REFERRER}/`)) return 'android';
  return 'web';
}

function readSession(): boolean {
  try {
    return sessionStorage.getItem(ANDROID_SESSION_KEY) === '1';
  } catch {
    return false; // Storage blocked: only the first page of the app knows it is the app.
  }
}

function writeSession(): void {
  try {
    sessionStorage.setItem(ANDROID_SESSION_KEY, '1');
  } catch {
    // Storage blocked: see readSession.
  }
}

let current: Platform | undefined;

// The first call reads the address, so call it before code that removes "playPurchase" (src/page/play-open.ts).
export function platform(): Platform {
  current ??= platformOf({ userAgent: navigator.userAgent, referrer: document.referrer, search: location.search, androidInSession: readSession() });
  if (current === 'android') writeSession();
  return current;
}

export function markPlatform(): void {
  document.documentElement.dataset.platform = platform();
}

// The device of a browser visitor, for the "Get the app" link. Only the Android app is in a public store.
export type AppVisitor = {
  platform: Platform;
  // True on an iPhone or an iPad. iPadOS 13 and later names a Mac in the user agent, but a Mac has no touch screen.
  apple: boolean;
  // True when the site runs as an installed web app (display-mode: standalone). It also catches the Android app
  // when the session marker is lost.
  installed: boolean;
};

export const appleOf = (userAgent: string, maxTouchPoints: number): boolean =>
  userAgent.includes('iPhone') || userAgent.includes('iPad') || (userAgent.includes('Macintosh') && maxTouchPoints > 1);

export const offersPlayApp = (visitor: AppVisitor, stage: PlayStage | undefined): boolean =>
  stage === 'live' && visitor.platform === 'web' && !visitor.apple && !visitor.installed;

export const appVisitor = (): AppVisitor => ({
  platform: platform(),
  apple: appleOf(navigator.userAgent, navigator.maxTouchPoints),
  installed: matchMedia('(display-mode: standalone)').matches,
});

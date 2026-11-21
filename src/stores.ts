// Where the apps stand in the stores (GET /api/stores, rust/server/src/stores.rs), asked once per page.
import { OnlineError, api } from './online.ts';
import { platform } from './platform.ts';
import type { Stores } from './protocol.ts';

// The store pages of the apps. The App Store id is the Apple ID of the app (the APPLE_APP_ID setting of the server).
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.yardenzamir.tick3d';
export const APP_STORE_URL = 'https://apps.apple.com/app/id6821623182';

let asked: Promise<Stores | undefined> | undefined;

// The stage of each app, or undefined when the server is out of reach.
export function storeStages(): Promise<Stores | undefined> {
  asked ??= api.stores().catch((error: unknown) => {
    if (error instanceof OnlineError) return undefined;
    throw error;
  });
  return asked;
}

// "Share tick3d" shares /share. While the app is in the closed test, /share explains how to join the test on Google
// Play, so the iOS app hides the button (data-hide-in="ios"). Once the app is live, /share is the page for everyone,
// and the iOS app shows it. /share always opens in the browser, never in the iOS app (no universal links).
export function showShareSiteInIosWhenLive(button: HTMLElement): void {
  if (platform() !== 'ios') return;
  void storeStages().then((stores) => {
    if (stores?.play === 'live') delete button.dataset.hideIn;
  });
}

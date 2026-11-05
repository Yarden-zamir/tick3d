// Where the apps stand in the stores (GET /api/stores, rust/server/src/stores.rs), asked once per page.
import { OnlineError, api } from './online.ts';
import { platform } from './platform.ts';
import type { PlayStage } from './protocol.ts';

let asked: Promise<PlayStage | undefined> | undefined;

// The stage of the Android app on Google Play, or undefined when the server is out of reach.
export function playStage(): Promise<PlayStage | undefined> {
  asked ??= api.stores().then(
    (stores) => stores.play,
    (error: unknown) => {
      if (error instanceof OnlineError) return undefined;
      throw error;
    },
  );
  return asked;
}

// "Share tick3d" shares /share. While the app is in the closed test, /share explains how to join the test on Google
// Play, so the iOS app hides the button (data-hide-in="ios"). Once the app is live, /share is the page for everyone,
// and the iOS app shows it. /share always opens in the browser, never in the iOS app (no universal links).
export function showShareSiteInIosWhenLive(button: HTMLElement): void {
  if (platform() !== 'ios') return;
  void playStage().then((stage) => {
    if (stage === 'live') delete button.dataset.hideIn;
  });
}

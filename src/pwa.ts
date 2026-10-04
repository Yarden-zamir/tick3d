import { registerSW } from 'virtual:pwa-register';

type PwaHandlers = {
  // The app shell is on the device: the game now opens without a network.
  onOfflineReady(): void;
  // A new version is waiting. Calling `reload` activates it and reloads the page.
  onNeedRefresh(reload: () => Promise<void>): void;
};

export function setupPwa(handlers: PwaHandlers): void {
  // A service worker needs a secure context. A LAN host on plain HTTP has none, so it runs online only.
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    onOfflineReady: () => handlers.onOfflineReady(),
    onNeedRefresh: () => handlers.onNeedRefresh(() => update(true)),
  });
}

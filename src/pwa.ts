import { registerSW } from 'virtual:pwa-register';

type PwaHandlers = {
  // The app shell is on the device: the game now opens without a network.
  onOfflineReady(): void;
  // A new version is waiting. Calling `reload` activates it and reloads the page.
  onNeedRefresh(reload: () => Promise<void>): void;
};

// The page reloads itself after this long, even if the new version never reports that it took over.
const RELOAD_FALLBACK_MS = 3000;

export function setupPwa(handlers: PwaHandlers): void {
  // A service worker needs a secure context. A LAN host on plain HTTP has none, so it runs online only.
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    onOfflineReady: () => handlers.onOfflineReady(),
    onNeedRefresh: () => handlers.onNeedRefresh(activateNewVersion),
  });
}

// Activates the waiting version and reloads once it controls the page. It asks the browser for the
// waiting worker at click time: after another deploy, the worker that announced the update can be
// gone, and a message to it would do nothing.
async function activateNewVersion(): Promise<void> {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => location.reload(), RELOAD_FALLBACK_MS);
}

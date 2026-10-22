import { registerSW } from 'virtual:pwa-register';

type PwaHandlers = {
  // A new version is waiting. Calling `reload` activates it and reloads the page.
  onNeedRefresh(reload: () => Promise<void>): void;
};

// The page reloads itself after this long, even if the new version never reports that it took over.
const RELOAD_FALLBACK_MS = 3000;

export function setupPwa(handlers: PwaHandlers): void {
  // A service worker needs a secure context. A LAN host on plain HTTP has none, so it runs online only.
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    onNeedRefresh: () => handlers.onNeedRefresh(activateNewVersion),
  });
}

// Loads a newer version of the page, if the server has one. An online game continues after the reload,
// because the address holds its code. A page without a new version stays as it is, so this never loops.
// Limit: a page without a service worker (a LAN host on plain HTTP) does nothing here. Revisit this if a
// LAN host gets updates while players play.
export async function loadNewVersion(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) return;
  try {
    await registration.update();
  } catch {
    return; // No network: the stream and the next refresh try again.
  }
  const installing = registration.installing;
  if (installing !== null) {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (installing.state === 'installing') return;
        installing.removeEventListener('statechange', check);
        resolve();
      };
      installing.addEventListener('statechange', check);
      check();
    });
  }
  if (registration.waiting !== null) return activateNewVersion();
  // A page of a first visit has no service worker in control, and the new version can be active already.
  // A reload then loads the page through the active worker.
  if (installing !== null && installing.state !== 'redundant' && navigator.serviceWorker.controller === null) location.reload();
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

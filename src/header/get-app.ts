// "Get the app" in the footer of every page: a link to the app in its store. It shows only in a browser that can
// install an app that is live (appOffer in src/platform.ts).
import { element } from '../element.ts';
import { type AppOffer, appOffer, appVisitor } from '../platform.ts';
import { APP_STORE_URL, PLAY_URL, storeStages } from '../stores.ts';

const getAppLink = element('#get-app-link', HTMLAnchorElement);

const LINKS: Record<AppOffer, { href: string; label: string; tip: string }> = {
  play: { href: PLAY_URL, label: 'Get the app on Google Play', tip: 'The Android app on Google Play' },
  'app-store': { href: APP_STORE_URL, label: 'Get the app on the App Store', tip: 'The iPhone and iPad app on the App Store' },
};

export function setupGetApp(): void {
  const visitor = appVisitor();
  // Ask the server only when the answer can change what shows.
  if (appOffer(visitor, { play: 'live', apple: 'live' }) === undefined) return;
  void storeStages().then((stores) => {
    const offer = appOffer(visitor, stores);
    if (offer === undefined) return;
    const link = LINKS[offer];
    getAppLink.href = link.href;
    getAppLink.setAttribute('aria-label', link.label);
    getAppLink.dataset.tip = link.tip;
    getAppLink.hidden = false;
  });
}

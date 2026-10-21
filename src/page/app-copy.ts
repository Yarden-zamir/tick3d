// The paid Android app: on each start in the app, the page reports the open with the inviter that /share kept
// (src/copies.ts). The first open makes the copy of this device, and counts for the inviter. The account that is
// logged in on this device holds the copy, so no step on the page is needed.
// Limit: the iPhone app (Capacitor) has its own storage and TestFlight is free, so an iPhone reports nothing.
// Revisit this when the iPhone app is paid: count an open of the iOS app with an inviter that it can see.
import { OnlineError, api } from '../online.ts';
import { isAndroidApp } from '../platform.ts';
import { storedInviter } from '../share/invite.ts';
import { page } from './state.ts';

export async function reportAppOpen(): Promise<void> {
  // The app check comes first: only the launch page has the referrer, and the check keeps it for the session.
  if (!isAndroidApp() || !navigator.onLine) return;
  let hasCopy: boolean;
  try {
    hasCopy = await api.reportAppOpen(storedInviter());
  } catch (error) {
    // No network: the next start reports again.
    if (error instanceof OnlineError) return;
    throw error;
  }
  page.account = { ...page.account, hasCopy };
}

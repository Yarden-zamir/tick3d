// The Android app reports once that it opened on a phone that an invite link brought to /testing. The app is
// paid, so an open means a purchase or a redeemed code, and the invite counts for the inviter (src/achievements.ts).
// Limit: the iPhone app (Capacitor) has its own storage, and TestFlight is free, so an iPhone never reports.
// Revisit this when the iPhone app is paid and can read the inviter.
import { OnlineError, api } from '../online.ts';
import { isAndroidApp } from '../platform.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { storedInviter } from '../testing/invite.ts';

export async function reportInviteInstall(): Promise<void> {
  // The app check comes first: only the launch page has the referrer, and the check keeps it for the session.
  if (!isAndroidApp() || !navigator.onLine) return;
  const by = storedInviter();
  if (by === null) return;
  try {
    if (localStorage.getItem(STORAGE_KEYS.inviteInstallReported) !== null) return;
    // The server keeps the first report of a person, so a repeat after a failed write here does no harm.
    await api.reportInviteInstall(by);
    localStorage.setItem(STORAGE_KEYS.inviteInstallReported, JSON.stringify(by));
  } catch (error) {
    // No network, or blocked storage: the next start tries again.
    if (error instanceof OnlineError || error instanceof DOMException) return;
    throw error;
  }
}

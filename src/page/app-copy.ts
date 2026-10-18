// The paid Android app: on each start in the app, the page reports the open with the inviter that /share kept
// (src/copies.ts). The first open makes the copy of this device, and counts for the inviter. When the player is
// logged in, the account holds no copy and the copy of this device is free, a popup offers the activation.
// Limit: the iPhone app (Capacitor) has its own storage and TestFlight is free, so an iPhone reports nothing.
// Revisit this when the iPhone app is paid: count an open of the iOS app with an inviter that it can see.
import { type CopyState, offersActivation } from '../copies.ts';
import { type EpochMs, epochNow, isEpochMs } from '../epoch.ts';
import { OnlineError, api } from '../online.ts';
import { isAndroidApp } from '../platform.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { storedInviter } from '../share/invite.ts';
import { activateDialog, activateLater, activateText, activateYes } from './dom.ts';
import { showError, showToast } from './feedback.ts';
import { page } from './state.ts';

function askedAt(): EpochMs | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.activationAskedAt) ?? 'null');
    return isEpochMs(value) ? value : null;
  } catch {
    return null;
  }
}

function setCopy(copy: CopyState): void {
  page.account = { ...page.account, copy };
}

export async function reportAppOpen(): Promise<void> {
  // The app check comes first: only the launch page has the referrer, and the check keeps it for the session.
  if (!isAndroidApp() || !navigator.onLine) return;
  let copy: CopyState;
  try {
    copy = await api.reportAppOpen(storedInviter());
  } catch (error) {
    // No network: the next start reports again.
    if (error instanceof OnlineError) return;
    throw error;
  }
  setCopy(copy);
  const user = page.account.user;
  if (user === null || !offersActivation({ inApp: true, loggedIn: true, copy, askedAt: askedAt(), now: epochNow() })) return;
  activateText.textContent = `Thank you for buying tick3d! Activate it on your account ${user.login}?`;
  activateDialog.showModal();
  activateYes.focus();
}

export function setupAppCopy(): void {
  activateYes.addEventListener('click', () => {
    activateYes.disabled = true;
    api
      .activateCopy()
      .then((copy) => {
        setCopy(copy);
        activateDialog.close();
        showToast('Activated. Thank you!');
      })
      .catch(showError)
      .finally(() => {
        activateYes.disabled = false;
      });
  });
  // "Not now", and Escape, ask again on a later start, at most once a day.
  const later = () => {
    try {
      localStorage.setItem(STORAGE_KEYS.activationAskedAt, JSON.stringify(epochNow()));
    } catch {
      // Storage is blocked: the popup asks again on the next start.
    }
  };
  activateLater.addEventListener('click', () => {
    later();
    activateDialog.close();
  });
  activateDialog.addEventListener('cancel', later);
}

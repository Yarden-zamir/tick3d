// The paid Android app: on each start in the app, the page reports the open with the inviter that /share kept
// (src/copies.ts). The first open makes the copy of this device, and counts for the inviter. When the player is
// logged in, the account holds no copy and may activate the copy of this device, a popup offers the activation.
// Limit: the iPhone app (Capacitor) has its own storage and TestFlight is free, so an iPhone reports nothing.
// Revisit this when the iPhone app is paid: count an open of the iOS app with an inviter that it can see.
import { type CopyState, offersActivation } from '../copies.ts';
import { type EpochMs, epochNow, isEpochMs } from '../epoch.ts';
import { OnlineError, api } from '../online.ts';
import { isAndroidApp } from '../platform.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { storedInviter } from '../share/invite.ts';
import { activateAvatar, activateDialog, activateExplain, activateLogin, activateMore, activateNo, activateOther, activateYes } from './dom.ts';
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

function declinedBy(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.activationDeclinedBy);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is blocked: the popup asks again on the next start.
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
  if (user === null) return;
  if (!offersActivation({ inApp: true, loggedIn: true, copy, declined: declinedBy() === user.login, askedAt: askedAt(), now: epochNow() })) return;
  activateAvatar.src = user.avatar;
  activateLogin.textContent = user.login;
  activateExplain.textContent = `Continue activates your game on ${user.login}. Then the game belongs to this account on every device.`;
  showOther(false);
  activateDialog.showModal();
  activateYes.focus();
}

function showOther(shown: boolean): void {
  activateOther.hidden = !shown;
  activateMore.setAttribute('aria-expanded', String(shown));
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
  activateMore.addEventListener('click', () => showOther(activateMore.getAttribute('aria-expanded') !== 'true'));
  // The account keeps no copy, and this device does not ask that account again.
  activateNo.addEventListener('click', () => {
    const user = page.account.user;
    if (user !== null) remember(STORAGE_KEYS.activationDeclinedBy, user.login);
    activateDialog.close();
  });
  // Escape asks again on a later start, at most once a day.
  activateDialog.addEventListener('cancel', () => remember(STORAGE_KEYS.activationAskedAt, JSON.stringify(epochNow())));
}

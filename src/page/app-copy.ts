// Only the server can accept a store proof. The Android launch referrer is not purchase evidence.
import { type AppOpen, parseAppleDeviceId } from '../copies.ts';
import { OnlineError, api } from '../online.ts';
import { parsePersonId } from '../protocol.ts';
import { storedInviter } from '../share/invite.ts';
import { page } from './state.ts';
import { receivePlayOpen } from './play-open.ts';
import { Capacitor, registerPlugin } from '@capacitor/core';

// Listen before storage and account loading can delay the native message channel.
const playOpen = receivePlayOpen();

// `device` is AppStore.deviceVerificationID in lower case (apple/native/PurchasePlugin.swift).
const purchase = registerPlugin<{ proof(): Promise<{ jws: string; device: string }> }>('Purchase');

export async function reportAppOpen(): Promise<void> {
  const native = await playOpen;
  const url = new URL(location.href);
  const proof = native?.proof ?? url.searchParams.get('playProof');
  const referrer = native?.referrer ?? url.searchParams.get('playReferrer');
  // Remove the bearer proof before any link or share can carry it elsewhere.
  url.searchParams.delete('playProof');
  url.searchParams.delete('playReferrer');
  history.replaceState(history.state, '', url);
  if (!navigator.onLine) return;
  const by = storedInviter() ?? parsePersonId(new URLSearchParams(referrer ?? '').get('by')) ?? null;
  let open: AppOpen;
  if (Capacitor.getPlatform() === 'ios') {
    // Old shells have no plugin. They must update before they can prove a purchase.
    if (!Capacitor.isPluginAvailable('Purchase')) return;
    let answer: { jws: string; device: string };
    try {
      answer = await purchase.proof();
    } catch {
      // StoreKit can be offline too. The next app open retries.
      return;
    }
    const device = parseAppleDeviceId(answer.device);
    if (device === undefined) throw new Error('invalid device id from the Purchase plugin');
    open = { by, proof: answer.jws, store: 'apple', device };
  } else {
    if (proof === null) return;
    open = { by, proof, store: 'play' };
  }
  let hasCopy: boolean;
  try {
    hasCopy = await api.reportAppOpen(open);
  } catch (error) {
    // Purchase checks can be unavailable or refused. Keep the last copy state and retry next open.
    if (error instanceof OnlineError) return;
    throw error;
  }
  page.account = { ...page.account, hasCopy };
}

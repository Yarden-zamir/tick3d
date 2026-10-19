// Only the server can accept a store proof. The Android launch referrer is not purchase evidence.
import { OnlineError, api } from '../online.ts';
import { parsePersonId } from '../protocol.ts';
import { storedInviter } from '../share/invite.ts';
import { page } from './state.ts';
import { receivePlayOpen } from './play-open.ts';
import { Capacitor, registerPlugin } from '@capacitor/core';

// Listen before storage and account loading can delay the native message channel.
const playOpen = receivePlayOpen();

const purchase = registerPlugin<{ proof(): Promise<{ jws: string }> }>('Purchase');

export async function reportAppOpen(): Promise<void> {
  const native = await playOpen;
  const url = new URL(location.href);
  let proof = native?.proof ?? url.searchParams.get('playProof');
  const referrer = native?.referrer ?? url.searchParams.get('playReferrer');
  // Remove the bearer proof before any link or share can carry it elsewhere.
  url.searchParams.delete('playProof');
  url.searchParams.delete('playReferrer');
  history.replaceState(history.state, '', url);
  if (!navigator.onLine) return;
  const store = Capacitor.getPlatform() === 'ios' ? 'apple' : 'play';
  if (store === 'apple') {
    // Old shells have no plugin. They must update before they can prove a purchase.
    if (!Capacitor.isPluginAvailable('Purchase')) return;
    try {
      proof = (await purchase.proof()).jws;
    } catch {
      // StoreKit can be offline too. The next app open retries.
      return;
    }
  }
  if (proof === null) return;
  let hasCopy: boolean;
  try {
    hasCopy = await api.reportAppOpen(storedInviter() ?? parsePersonId(new URLSearchParams(referrer ?? '').get('by')) ?? null, proof, store);
  } catch (error) {
    // No network: the next start reports again.
    if (error instanceof OnlineError && error.status === undefined) return;
    throw error;
  }
  page.account = { ...page.account, hasCopy };
}

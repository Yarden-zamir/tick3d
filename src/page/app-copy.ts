// Only the server can accept a store proof. The Android launch referrer is not purchase evidence.
import { OnlineError, api } from '../online.ts';
import { parsePersonId } from '../protocol.ts';
import { storedInviter } from '../share/invite.ts';
import { page } from './state.ts';

export async function reportAppOpen(): Promise<void> {
  const url = new URL(location.href);
  const proof = url.searchParams.get('playProof');
  const referrer = url.searchParams.get('playReferrer');
  // Remove the bearer proof before any link or share can carry it elsewhere.
  url.searchParams.delete('playProof');
  url.searchParams.delete('playReferrer');
  history.replaceState(history.state, '', url);
  if (proof === null || !navigator.onLine) return;
  let hasCopy: boolean;
  try {
    hasCopy = await api.reportAppOpen(storedInviter() ?? parsePersonId(new URLSearchParams(referrer ?? '').get('by')) ?? null, proof);
  } catch (error) {
    // No network: the next start reports again.
    if (error instanceof OnlineError) return;
    throw error;
  }
  page.account = { ...page.account, hasCopy };
}

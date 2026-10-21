// The invite link of /share: the share buttons put the public person id of the sharer in it (`by`), never a name
// or a token. A claim or an app open through it counts for the invite achievements of that person (src/achievements.ts).
import { type PersonId, parsePersonId } from '../protocol.ts';
import { PAGES } from '../pages.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';

// The /share page of this host, with `by` when the person is known. Production and a preview share their own page.
export function inviteUrl(origin: string, person: PersonId | null): string {
  const page = `${origin}${PAGES.share.path}`;
  return person === null ? page : `${page}?by=${person}`;
}

// The inviter of this browser: the stored one, else the `by` of this visit. The first inviter wins, so a later
// visit without `by`, or with another `by`, still credits them. A `by` that is no person id counts for nobody.
export function inviterOf(stored: unknown, search: string): PersonId | null {
  return parsePersonId(stored) ?? parsePersonId(new URLSearchParams(search).get('by')) ?? null;
}

// The inviter that /share keeps in this browser. The Android app shares the storage of Chrome, so it reads it too.
export function storedInviter(): PersonId | null {
  try {
    return inviterOf(JSON.parse(localStorage.getItem(STORAGE_KEYS.testerInvitedBy) ?? 'null'), '');
  } catch {
    return null;
  }
}

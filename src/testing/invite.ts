// The invite link of /testing: the share button puts the person id of the sharer in it (`by`), and a claim
// through it counts for the invite achievements of that person (src/achievements.ts).
import { type PersonId, parsePersonId } from '../protocol.ts';
import { isRecord } from '../guards.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';

// Production shares the short address (Caddyfile.j2), which keeps the query on its redirect to /testing.
// Other hosts, such as a preview, share their own page. Without a known person, the link has no `by`.
export function inviteUrl(location: Pick<Location, 'hostname' | 'origin'>, person: PersonId | null): string {
  const page = location.hostname === 'tick3d.yarden-zamir.com' ? 'https://testing.tick3d.yarden-zamir.com/' : `${location.origin}/testing`;
  return person === null ? page : `${page}?by=${person}`;
}

// The inviter of this browser: the stored one, else the `by` of this visit. The first inviter wins, so a later
// visit without `by`, or with another `by`, still credits them. A `by` that is no person id counts for nobody.
export function inviterOf(stored: unknown, search: string): PersonId | null {
  return parsePersonId(stored) ?? parsePersonId(new URLSearchParams(search).get('by')) ?? null;
}

// The inviter that /testing keeps in this browser. The Android app shares the storage of Chrome, so it reads it too.
export function storedInviter(): PersonId | null {
  try {
    return inviterOf(JSON.parse(localStorage.getItem(STORAGE_KEYS.testerInvitedBy) ?? 'null'), '');
  } catch {
    return null;
  }
}

// The body of POST /api/invites/installs: the inviter of the person whose Android app opened.
export function parseInviteInstallRequest(value: unknown): { by: PersonId } | undefined {
  const by = isRecord(value) ? parsePersonId(value.by) : undefined;
  return by === undefined ? undefined : { by };
}

// The answer of POST /api/invites/installs.
export function parseInviteInstall(value: unknown): { counted: boolean } | undefined {
  return isRecord(value) && typeof value.counted === 'boolean' ? { counted: value.counted } : undefined;
}

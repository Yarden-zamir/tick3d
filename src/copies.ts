// Bought copies of the paid Android app. A copy is a device (player token) where the app opened. The account that is
// logged in on that device holds the copy, or the device without a login. The server keeps the tokens.
// The page and the server share these shapes (POST /api/copies, GET /api/me).
import { isRecord } from './guards.ts';
import { type PersonId, parsePersonId } from './protocol.ts';

// The body of POST /api/copies: the inviter that /share kept in this browser, or null.
export type AppOpen = { by: PersonId | null };

export function parseAppOpen(value: unknown): AppOpen | undefined {
  if (!isRecord(value)) return undefined;
  const by = value.by === null ? null : parsePersonId(value.by);
  return by === undefined ? undefined : { by };
}

// The answer of POST /api/copies: whether the player holds a copy.
export function parseCopyAnswer(value: unknown): { hasCopy: boolean } | undefined {
  return isRecord(value) && typeof value.hasCopy === 'boolean' ? { hasCopy: value.hasCopy } : undefined;
}

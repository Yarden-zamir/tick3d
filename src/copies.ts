// Proved copies of the paid store apps. A copy is a device (player token) where the app opened. The account that is
// logged in on that device holds the copy, or the device without a login. The server keeps the tokens.
// The page and the server share these shapes (POST /api/copies, GET /api/me).
import { isRecord } from './guards.ts';
import { type PersonId, parsePersonId } from './protocol.ts';

// The body of POST /api/copies: a signed store proof and the inviter, or null.
export type AppOpen = { by: PersonId | null; proof: string; store: 'play' | 'apple' };

export function parseAppOpen(value: unknown): AppOpen | undefined {
  if (!isRecord(value) || typeof value.proof !== 'string' || value.proof.length === 0 || value.proof.length > 32_768) return undefined;
  const by = value.by === null ? null : parsePersonId(value.by);
  return by === undefined || (value.store !== 'play' && value.store !== 'apple') ? undefined : { by, proof: value.proof, store: value.store };
}

// The answer of POST /api/copies: whether the player holds a copy.
export function parseCopyAnswer(value: unknown): { hasCopy: boolean } | undefined {
  return isRecord(value) && typeof value.hasCopy === 'boolean' ? { hasCopy: value.hasCopy } : undefined;
}

// Bought copies of the paid Android app. A copy is a device (player token) where the app opened. It is unactivated,
// or activated by exactly one GitHub account, and an account holds at most one copy. The server keeps the tokens.
// The page and the server share these shapes (POST /api/copies, POST /api/copies/activate, GET /api/me).
import type { EpochMs } from './epoch.ts';
import { isRecord } from './guards.ts';
import { type PersonId, parsePersonId } from './protocol.ts';

// The paid state of this browser: 'activated' when the logged-in account holds a copy, 'device' when this device
// holds a copy that no account activated, else 'none'. A copy that another account activated is 'none' here.
export const COPY_STATES = ['none', 'device', 'activated'] as const;
export type CopyState = (typeof COPY_STATES)[number];
export const isCopyState = (value: unknown): value is CopyState => COPY_STATES.some((state) => state === value);

// The body of POST /api/copies: the inviter that /share kept in this browser, or null.
export type AppOpen = { by: PersonId | null };

export function parseAppOpen(value: unknown): AppOpen | undefined {
  if (!isRecord(value)) return undefined;
  const by = value.by === null ? null : parsePersonId(value.by);
  return by === undefined ? undefined : { by };
}

// The answer of POST /api/copies and POST /api/copies/activate.
export function parseCopyAnswer(value: unknown): { copy: CopyState } | undefined {
  return isRecord(value) && isCopyState(value.copy) ? { copy: value.copy } : undefined;
}

// "Not now" on the activation popup asks again on a later app open, at most once a day.
export const ACTIVATION_ASK_MS = 24 * 3_600_000;

// The activation popup shows in the Android app, for a logged-in player whose account holds no copy, on a device
// whose copy no account activated ('device'), unless the player said "Not now" in the last day.
export function offersActivation(state: { inApp: boolean; loggedIn: boolean; copy: CopyState; askedAt: EpochMs | null; now: EpochMs }): boolean {
  if (!state.inApp || !state.loggedIn || state.copy !== 'device') return false;
  return state.askedAt === null || state.now - state.askedAt >= ACTIVATION_ASK_MS;
}

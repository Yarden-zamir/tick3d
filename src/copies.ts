// Proved copies of the paid store apps. A copy is a device (player token) where the app opened. The account that is
// logged in on that device holds the copy, or the device without a login. The server keeps the tokens.
// The page and the server share these shapes (POST /api/copies, GET /api/me).
import { isRecord } from './guards.ts';
import { type PersonId, parsePersonId } from './protocol.ts';

// The App Store id of an iPhone (AppStore.deviceVerificationID): a UUID in lower case. The signed purchase proves it
// with its deviceVerification hash (server/apple-proof.ts), so it names the device slot of a purchase.
export type AppleDeviceId = string & { readonly brand: 'AppleDeviceId' };

const HEX = '0123456789abcdef';
const UUID_DASHES = [8, 13, 18, 23];

export function parseAppleDeviceId(value: unknown): AppleDeviceId | undefined {
  if (typeof value !== 'string' || value.length !== 36) return undefined;
  const valid = [...value].every((char, index) => (UUID_DASHES.includes(index) ? char === '-' : HEX.includes(char)));
  return valid ? (value as AppleDeviceId) : undefined;
}

// The body of POST /api/copies: a signed store proof and the inviter, or null. An Apple proof also names the device.
export type AppOpen = { by: PersonId | null; proof: string } & ({ store: 'play' } | { store: 'apple'; device: AppleDeviceId });

export function parseAppOpen(value: unknown): AppOpen | undefined {
  if (!isRecord(value) || typeof value.proof !== 'string' || value.proof.length === 0 || value.proof.length > 32_768) return undefined;
  const by = value.by === null ? null : parsePersonId(value.by);
  if (by === undefined) return undefined;
  if (value.store === 'play' && value.device === undefined) return { by, proof: value.proof, store: 'play' };
  const device = parseAppleDeviceId(value.device);
  return value.store === 'apple' && device !== undefined ? { by, proof: value.proof, store: 'apple', device } : undefined;
}

// The answer of POST /api/copies: whether the player holds a copy.
export function parseCopyAnswer(value: unknown): { hasCopy: boolean } | undefined {
  return isRecord(value) && typeof value.hasCopy === 'boolean' ? { hasCopy: value.hasCopy } : undefined;
}

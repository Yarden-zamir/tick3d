// The Google Play promo codes of the Android closed test (/testing). The server and the page share these shapes.
// A code goes to one tester. The public list shows a hint of each code, never the full code, and never an email.
import { isRecord, isUnknownArray } from '../guards.ts';
import { type PersonId, parsePersonId } from '../protocol.ts';

// Google Play codes have 23 characters. The range leaves room for other code kinds.
export const CODE_MIN_LENGTH = 10;
export const CODE_MAX_LENGTH = 30;
// The public list shows this many first characters of a code.
export const HINT_LENGTH = 3;
export const TESTER_NAME_MAX_LENGTH = 40;
export const EMAIL_MAX_LENGTH = 254;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// One code of the list. `name` and `gravatar` are null for a free code. `gravatar` is null for a code
// without an email (a code that the maintainer gave out by hand).
export type TesterCode = { id: number; hint: string; claimed: boolean; name: string | null; gravatar: string | null };
export type TesterCodes = { codes: TesterCode[] };
// `by` is the person id of the inviter: the `by` value of the invite link (/testing?by=<person id>), or null.
export type ClaimRequest = { email: string; name: string; by: PersonId | null };
export type ClaimedCode = { code: string };
// One entry of the TESTER_CODES setting: a free code, or a code that `name` holds already.
export type TesterCodeEntry = { code: string; name: string | null };

const isTesterCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= CODE_MIN_LENGTH && value.length <= CODE_MAX_LENGTH && [...value].every((char) => CODE_CHARS.includes(char));

export const hintOf = (code: string): string => code.slice(0, HINT_LENGTH);

// A display name: 1 to 40 characters after a trim, with the spaces inside joined to one.
// Letters and digits of every script, spaces, and the marks of names: - _ . '
function parseTesterName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().split(/\s+/u).join(' ');
  const length = [...name].length;
  if (length < 1 || length > TESTER_NAME_MAX_LENGTH) return undefined;
  // A regex is the simplest way to match the letters and digits of every script (Unicode properties).
  return /^[\p{L}\p{M}\p{Nd} _.'-]+$/u.test(name) && /[\p{L}\p{Nd}]/u.test(name) ? name : undefined;
}

// A simple shape check of an email address: one "@", a name before it, and a domain with a dot after it.
// Limit: it accepts some addresses that cannot receive mail. The maintainer reads each one by hand.
function parseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim();
  if (email.length > EMAIL_MAX_LENGTH || [...email].some((char) => char.trim() === '')) return undefined;
  const parts = email.split('@');
  if (parts.length !== 2) return undefined;
  const [local = '', domain = ''] = parts;
  const labels = domain.split('.');
  return local.length > 0 && labels.length >= 2 && labels.every((label) => label.length > 0) ? email : undefined;
}

// A missing or null `by` is a claim without an invite. A `by` that is no person id makes the request invalid.
export function parseClaimRequest(value: unknown): ClaimRequest | undefined {
  if (!isRecord(value)) return undefined;
  const email = parseEmail(value.email);
  const name = parseTesterName(value.name);
  const by = value.by === undefined || value.by === null ? null : parsePersonId(value.by);
  return email === undefined || name === undefined || by === undefined ? undefined : { email, name, by };
}

// The TESTER_CODES setting: entries split by commas or new lines. An entry is `CODE` (free) or
// `CODE=Name` (given out already, to Name). It throws on a bad entry, so a typo stops the API start.
export function parseTesterCodeEntries(text: string): TesterCodeEntry[] {
  const entries = text
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const equals = entry.indexOf('=');
    const code = (equals === -1 ? entry : entry.slice(0, equals)).trim();
    if (!isTesterCode(code)) {
      throw new Error(`TESTER_CODES entry ${index + 1}: a code has ${CODE_MIN_LENGTH} to ${CODE_MAX_LENGTH} characters from A-Z and 0-9`);
    }
    if (seen.has(code)) throw new Error(`TESTER_CODES entry ${index + 1}: the code ${hintOf(code)}… comes twice`);
    seen.add(code);
    if (equals === -1) return { code, name: null };
    const name = parseTesterName(entry.slice(equals + 1));
    if (name === undefined) throw new Error(`TESTER_CODES entry ${index + 1}: the name after "=" is not a valid name`);
    return { code, name };
  });
}

const GRAVATAR_HASH_LENGTH = 64;
const HEX = '0123456789abcdef';
const isGravatarHash = (value: unknown): value is string =>
  typeof value === 'string' && value.length === GRAVATAR_HASH_LENGTH && [...value].every((char) => HEX.includes(char));

function parseTesterCode(value: unknown): TesterCode | undefined {
  if (!isRecord(value)) return undefined;
  const { id, hint, claimed, name, gravatar } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return undefined;
  if (typeof hint !== 'string' || hint.length !== HINT_LENGTH || typeof claimed !== 'boolean') return undefined;
  const shownName = name === null ? null : parseTesterName(name);
  if (shownName === undefined || shownName !== name || (claimed !== (name !== null))) return undefined;
  if (gravatar !== null && (!isGravatarHash(gravatar) || !claimed)) return undefined;
  return { id, hint, claimed, name: shownName, gravatar };
}

export function parseTesterCodes(value: unknown): TesterCodes | undefined {
  if (!isRecord(value) || !isUnknownArray(value.codes)) return undefined;
  const codes = value.codes.map(parseTesterCode);
  return codes.every((code) => code !== undefined) ? { codes } : undefined;
}

export function parseClaimedCode(value: unknown): ClaimedCode | undefined {
  return isRecord(value) && isTesterCode(value.code) ? { code: value.code } : undefined;
}

// The Play page that redeems a code.
export const redeemUrl = (code: string): string => `https://play.google.com/redeem?code=${encodeURIComponent(code)}`;

// A code that this browser claimed, as the page keeps it in localStorage. The name and email fill the next claim form.
export type MyCode = { id: number; code: string; name: string; email: string };

// The stored list of claimed codes. Storage can hold anything, so each entry passes the same checks as an
// answer from the server, and a bad entry drops out.
export function parseMyCodes(value: unknown): MyCode[] {
  if (!isUnknownArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { id, code } = entry;
    const name = parseTesterName(entry.name);
    const email = parseEmail(entry.email);
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !isTesterCode(code) || name === undefined || email === undefined) return [];
    return [{ id, code, name, email }];
  });
}

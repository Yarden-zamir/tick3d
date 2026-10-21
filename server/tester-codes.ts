// The Google Play promo codes of the closed test (src/share/codes.ts), from the TESTER_CODES setting.
// KitSHn fills it from the GitHub secret KITSHN_TESTER_CODES. The repository is public, so codes never go in git.
import { createHash } from 'node:crypto';
import { type TesterCodeEntry, parseTesterCodeEntries } from '../src/share/codes.ts';

// The KitSHn environment of production, as in server/previews.ts.
const PRODUCTION_ENVIRONMENT = 'prod';

// The codes to add at start. Production and a local server (no KITSHN_ENVIRONMENT) read TESTER_CODES.
// A pull request preview reads none, so a preview database never holds a real code.
// A bad entry throws, so the API does not start with a typo in the secret.
export function testerCodesFromEnv(env: NodeJS.ProcessEnv): TesterCodeEntry[] {
  const { TESTER_CODES, KITSHN_ENVIRONMENT } = env;
  if (KITSHN_ENVIRONMENT && KITSHN_ENVIRONMENT !== PRODUCTION_ENVIRONMENT) return [];
  return parseTesterCodeEntries(TESTER_CODES ?? '');
}

// The Gravatar hash of an email: SHA-256 of the trimmed, lower-case address (gravatar.com/site/implement/hash).
// Limit: the hash identifies an email to anybody who knows that email already. Revisit this if a tester
// objects, or when the page gets Sign in with Google (not now: it needs a Google OAuth client).
export const gravatarOf = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

// Classic Play Integrity requests use a server nonce. A restart drops outstanding nonces, not copies.
import { randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { isRecord } from '../src/guards.ts';
import manifest from '../android/twa-manifest.json' with { type: 'json' };
export class PurchaseProofError extends Error {
  status: 403 | 503;
  constructor(status: 403 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

const FRESH_MS = 5 * 60_000;

export function playDecoderFromEnv(env: NodeJS.ProcessEnv): ((token: string) => Promise<unknown>) | undefined {
  if (!env.PLAY_SERVICE_ACCOUNT_JSON) return undefined;
  const credentials: unknown = JSON.parse(env.PLAY_SERVICE_ACCOUNT_JSON);
  if (!isRecord(credentials) || typeof credentials.client_email !== 'string' || typeof credentials.private_key !== 'string') {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON needs client_email and private_key');
  }
  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/playintegrity'] });
  return async (token) => {
    const access = await auth.getAccessToken();
    if (!access) throw new Error('Google returned no access token');
    const response = await fetch(`https://playintegrity.googleapis.com/v1/${manifest.packageId}:decodeIntegrityToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new PurchaseProofError(503, 'Google Play could not check the purchase. Open the app again later.');
    return response.json();
  };
}

export function createPlayProof(decode: ((token: string) => Promise<unknown>) | undefined, now: () => number = Date.now) {
  // Limit: one API process owns these nonces. Revisit before adding another API process.
  const pending = new Map<string, number>();
  return {
    nonce(): string {
      for (const [nonce, issued] of pending) if (now() - issued >= FRESH_MS) pending.delete(nonce);
      if (pending.size >= 10_000) throw new PurchaseProofError(503, 'Too many purchase checks. Try again later.');
      const nonce = randomBytes(32).toString('base64url');
      pending.set(nonce, now());
      return nonce;
    },
    async verify(token: string): Promise<void> {
      if (decode === undefined) throw new PurchaseProofError(503, 'Purchase checks are not configured.');
      const result = await decode(token);
      const payload = isRecord(result) ? result.tokenPayloadExternal : undefined;
      const request = isRecord(payload) ? payload.requestDetails : undefined;
      const app = isRecord(payload) ? payload.appIntegrity : undefined;
      const account = isRecord(payload) ? payload.accountDetails : undefined;
      if (!isRecord(request) || !isRecord(app) || !isRecord(account)) throw new PurchaseProofError(403, 'Google Play did not prove this purchase.');
      const issued = typeof request.nonce === 'string' ? pending.get(request.nonce) : undefined;
      const timestamp = typeof request.timestampMillis === 'string' ? Number(request.timestampMillis) : NaN;
      if (issued === undefined || now() - issued >= FRESH_MS || !Number.isSafeInteger(timestamp) || timestamp < issued - 30_000 || timestamp > now() + 30_000 ||
        request.requestPackageName !== manifest.packageId || app.packageName !== manifest.packageId ||
        app.appRecognitionVerdict !== 'PLAY_RECOGNIZED' || account.appLicensingVerdict !== 'LICENSED') {
        throw new PurchaseProofError(403, 'Google Play did not prove this purchase. Open the app again.');
      }
      // No await between the lookup and delete: concurrent submissions cannot use one nonce twice.
      pending.delete(String(request.nonce));
    },
  };
}

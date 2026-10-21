import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Environment, SignedDataVerifier, VerificationException, type AppTransaction } from '@apple/app-store-server-library';
import { PurchaseProofError } from './play-proof.ts';
import type { AppleDeviceId } from '../src/copies.ts';

// `device` is the App Store id of the phone, proved by the signed deviceVerification hash. It names the device slot.
export type ApplePurchase = { appTransactionId: string; environment: 'Production' | 'Sandbox'; device: AppleDeviceId };

export function appleVerifierFromEnv(env: NodeJS.ProcessEnv): ((proof: string, device: AppleDeviceId) => Promise<ApplePurchase>) | undefined {
  const { APPLE_BUNDLE_ID, APPLE_APP_ID } = env;
  if (!APPLE_BUNDLE_ID && !APPLE_APP_ID) return undefined;
  const appId = Number(APPLE_APP_ID);
  if (!APPLE_BUNDLE_ID || !Number.isSafeInteger(appId) || appId < 1) throw new Error('Apple purchase checks need APPLE_BUNDLE_ID and a numeric APPLE_APP_ID');
  const roots = [readFileSync(new URL('./apple-roots/AppleRootCA-G3.cer', import.meta.url))];
  const production = new SignedDataVerifier(roots, true, Environment.PRODUCTION, APPLE_BUNDLE_ID, appId);
  // TestFlight uses Sandbox. Revisit this exception when the TestFlight link becomes public.
  const testflight = new SignedDataVerifier(roots, true, Environment.SANDBOX, APPLE_BUNDLE_ID);
  return createAppleProof(APPLE_BUNDLE_ID, (proof) => production.verifyAndDecodeAppTransaction(proof), (proof) => testflight.verifyAndDecodeAppTransaction(proof));
}

export function createAppleProof(bundleId: string, production: (proof: string) => Promise<AppTransaction>, sandbox: (proof: string) => Promise<AppTransaction>) {
  return async (proof: string, device: AppleDeviceId): Promise<ApplePurchase> => {
    let transaction: AppTransaction;
    try {
      transaction = await production(proof);
    } catch (error) {
      if (!(error instanceof VerificationException)) throw error;
      try {
        transaction = await sandbox(proof);
      } catch (error) {
        if (!(error instanceof VerificationException)) throw error;
        throw new PurchaseProofError(403, 'Apple did not prove this app purchase.');
      }
    }
    // AppTransaction has appTransactionId, not the in-app purchase field originalTransactionId.
    // Apple keeps this identifier across devices for one Apple account and app.
    const { appTransactionId, receiptType } = transaction;
    if (transaction.bundleId !== bundleId || (receiptType !== 'Production' && receiptType !== 'Sandbox') || !appTransactionId) {
      throw new PurchaseProofError(403, 'Apple did not return a purchase identifier for this app.');
    }
    // Apple's check: SHA-384 of the lower-case nonce and the lower-case device id, in Base64. A copied proof carries
    // the hash of the phone that it came from, so it works only with that phone's id, and so only in that phone's slot.
    const { deviceVerification, deviceVerificationNonce } = transaction;
    if (!deviceVerification || !deviceVerificationNonce) throw new PurchaseProofError(403, 'Apple did not tie this app purchase to a device.');
    const expected = createHash('sha384').update(`${deviceVerificationNonce.toLowerCase()}${device}`, 'ascii').digest('base64');
    if (expected !== deviceVerification) throw new PurchaseProofError(403, 'This app purchase belongs to another device.');
    return { appTransactionId, environment: receiptType, device };
  };
}

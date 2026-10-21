import { describe, expect, it } from 'vitest';
import { VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { appleVerifierFromEnv, createAppleProof } from './apple-proof.ts';
import { openStore } from './store.ts';
import type { PlayerToken } from '../src/protocol.ts';

const bundleId = 'com.example.tick3d';
const purchase = { appTransactionId: 'purchase-1', environment: 'Production' as const };

describe('Apple app purchase proof', () => {
  it('accepts a verified app transaction identifier, not an in-app transaction identifier', async () => {
    const verify = createAppleProof(bundleId, async () => ({ bundleId, receiptType: 'Production', appTransactionId: 'purchase-1' }), async () => { throw new Error('not sandbox'); });
    expect(await verify('signed')).toEqual(purchase);
  });
  it('accepts signed TestFlight Sandbox data only after verification', async () => {
    const verify = createAppleProof(bundleId, async () => { throw new VerificationException(VerificationStatus.INVALID_ENVIRONMENT); },
      async () => ({ bundleId, receiptType: 'Sandbox', appTransactionId: 'testflight-1' }));
    expect(await verify('signed')).toEqual({ appTransactionId: 'testflight-1', environment: 'Sandbox' });
  });
  it.each([
    { bundleId: 'wrong', receiptType: 'Production', appTransactionId: 'id' },
    { bundleId, receiptType: 'Xcode', appTransactionId: 'id' },
    { bundleId, receiptType: 'Production' },
  ])('refuses a wrong app, local environment or missing purchase identifier', async (transaction) => {
    await expect(createAppleProof(bundleId, async () => transaction, async () => transaction)('signed')).rejects.toMatchObject({ status: 403 });
  });
  it('rejects forged signed data through the real Apple verifier', async () => {
    const verify = appleVerifierFromEnv({ APPLE_BUNDLE_ID: bundleId, APPLE_APP_ID: '123456789' });
    expect(verify).toBeDefined();
    await expect(verify?.('eyJhbGciOiJub25lIn0.eyJidW5kbGVJZCI6ImNvbS5leGFtcGxlLnRpY2szZCJ9.')).rejects.toMatchObject({ status: 403 });
    expect(appleVerifierFromEnv({})).toBeUndefined();
    expect(() => appleVerifierFromEnv({ APPLE_APP_ID: 'bad' })).toThrow();
  });
  it('limits one purchase to five tokens, including concurrent reports, and permits repeat opens', async () => {
    const store = await openStore(':memory:');
    const token = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` as PlayerToken;
    try {
      const answers = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.reportAppOpen(token(i), null, purchase)));
      expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(5);
      expect(answers[5]).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await store.reportAppOpen(token(0), null, purchase)).toBe(true);
      await expect(store.reportAppOpen(token(0), null, { ...purchase, appTransactionId: 'another' })).rejects.toMatchObject({ status: 409 });
      expect(await store.reportAppOpen(token(6), null, { ...purchase, environment: 'Sandbox' })).toBe(true);
    } finally {
      await store.close();
    }
  });
});

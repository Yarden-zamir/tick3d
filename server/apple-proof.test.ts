import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { type ApplePurchase, appleVerifierFromEnv, createAppleProof } from './apple-proof.ts';
import { openStore } from './store.ts';
import { type AppleDeviceId, parseAppleDeviceId } from '../src/copies.ts';
import type { PlayerToken } from '../src/protocol.ts';

// DuckDB writes for each statement. A busy CI machine needs more than the default 5 s (as in server/store.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const bundleId = 'com.example.tick3d';
const NONCE = '6f1b9a0e-2d4c-4e8f-9a7b-3c5d1e2f4a6b';

const deviceId = (i: number): AppleDeviceId => {
  const device = parseAppleDeviceId(`0f1e2d3c-4b5a-4978-8a6b-${String(i).padStart(12, '0')}`);
  if (device === undefined) throw new Error('bad test device id');
  return device;
};
const token = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` as PlayerToken;
// The fields that Apple signs for one device (Apple's check: SHA-384 of the nonce and the device id, in Base64).
const signedFor = (device: string) => ({
  deviceVerificationNonce: NONCE,
  deviceVerification: createHash('sha384').update(`${NONCE}${device}`, 'ascii').digest('base64'),
});
const purchaseOn = (i: number, appTransactionId = 'purchase-1'): ApplePurchase => ({ appTransactionId, environment: 'Production', device: deviceId(i) });

describe('Apple app purchase proof', () => {
  it('accepts a verified app transaction on the device that it names', async () => {
    const verify = createAppleProof(bundleId, async () => ({ bundleId, receiptType: 'Production', appTransactionId: 'purchase-1', ...signedFor(deviceId(1)) }), async () => {
      throw new Error('not sandbox');
    });
    expect(await verify('signed', deviceId(1))).toEqual(purchaseOn(1));
  });
  it('accepts signed TestFlight Sandbox data only after verification', async () => {
    const verify = createAppleProof(bundleId, async () => {
      throw new VerificationException(VerificationStatus.INVALID_ENVIRONMENT);
    }, async () => ({ bundleId, receiptType: 'Sandbox', appTransactionId: 'testflight-1', ...signedFor(deviceId(1)) }));
    expect(await verify('signed', deviceId(1))).toEqual({ appTransactionId: 'testflight-1', environment: 'Sandbox', device: deviceId(1) });
  });
  it.each([
    { bundleId: 'wrong', receiptType: 'Production', appTransactionId: 'id', ...signedFor(deviceId(1)) },
    { bundleId, receiptType: 'Xcode', appTransactionId: 'id', ...signedFor(deviceId(1)) },
    { bundleId, receiptType: 'Production', ...signedFor(deviceId(1)) },
    { bundleId, receiptType: 'Production', appTransactionId: 'id' },
    { bundleId, receiptType: 'Production', appTransactionId: 'id', deviceVerificationNonce: NONCE },
  ])('refuses a wrong app, local environment, missing purchase identifier or missing device check', async (transaction) => {
    await expect(createAppleProof(bundleId, async () => transaction, async () => transaction)('signed', deviceId(1))).rejects.toMatchObject({ status: 403 });
  });
  it('refuses a copied proof with the id of another device', async () => {
    const transaction = { bundleId, receiptType: 'Production', appTransactionId: 'purchase-1', ...signedFor(deviceId(1)) };
    await expect(createAppleProof(bundleId, async () => transaction, async () => transaction)('signed', deviceId(2))).rejects.toMatchObject({ status: 403 });
  });
  it('rejects forged signed data through the real Apple verifier', async () => {
    const verify = appleVerifierFromEnv({ APPLE_BUNDLE_ID: bundleId, APPLE_APP_ID: '123456789' });
    expect(verify).toBeDefined();
    await expect(verify?.('eyJhbGciOiJub25lIn0.eyJidW5kbGVJZCI6ImNvbS5leGFtcGxlLnRpY2szZCJ9.', deviceId(1))).rejects.toMatchObject({ status: 403 });
    expect(appleVerifierFromEnv({})).toBeUndefined();
    expect(() => appleVerifierFromEnv({ APPLE_APP_ID: 'bad' })).toThrow();
  });
});

describe('the device slots of an Apple purchase', () => {
  it('holds five devices, including concurrent reports, and lets each device open again', async () => {
    const store = await openStore(':memory:');
    try {
      const answers = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.reportAppOpen(token(i), null, purchaseOn(i))));
      expect(answers.filter((answer) => answer.status === 'fulfilled')).toHaveLength(5);
      expect(answers[5]).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      expect(await store.reportAppOpen(token(0), null, purchaseOn(0))).toBe(true);
      // A copied proof only works with the id of the device that it came from, so a copy cannot add a slot.
      await expect(store.reportAppOpen(token(9), null, purchaseOn(7))).rejects.toMatchObject({ status: 403 });
      await expect(store.reportAppOpen(token(0), null, purchaseOn(0, 'another'))).rejects.toMatchObject({ status: 409 });
      expect(await store.reportAppOpen(token(6), null, { ...purchaseOn(6), environment: 'Sandbox' })).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('gives the slot of a device to its newest token, and frees the slots of deleted data and of unused devices', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tick3d-apple-slots-'));
    const path = join(directory, 'slots.duckdb');
    try {
      let store = await openStore(path);
      for (let i = 0; i < 5; i++) await store.reportAppOpen(token(i), null, purchaseOn(i));
      // The same phone with cleared app data: the slot moves, and the old token loses its proof.
      expect(await store.reportAppOpen(token(10), null, purchaseOn(0))).toBe(true);
      // Delete my data on one phone frees its slot.
      await store.deleteData(token(1));
      expect(await store.reportAppOpen(token(5), null, purchaseOn(5))).toBe(true);
      await expect(store.reportAppOpen(token(6), null, purchaseOn(6))).rejects.toMatchObject({ status: 403 });
      await store.close();

      const instance = await DuckDBInstance.create(path);
      const db = await instance.connect();
      expect((await db.runAndReadAll('FROM app_copies SELECT proved WHERE token = $token', { token: token(0) })).getRowObjectsJS()).toEqual([{ proved: false }]);
      expect((await db.runAndReadAll('FROM apple_slots SELECT token WHERE device = $device', { device: deviceId(0) })).getRowObjectsJS()).toEqual([{ token: token(10) }]);
      await db.run("UPDATE apple_slots SET last_seen_at = now() - INTERVAL 91 DAY WHERE device = $device", { device: deviceId(2) });
      db.closeSync();
      instance.closeSync();

      // A phone unused for 90 days frees its slot for a new one.
      store = await openStore(path);
      expect(await store.reportAppOpen(token(6), null, purchaseOn(6))).toBe(true);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

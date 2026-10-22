import { describe, expect, it } from 'vitest';
import { createPlayProof, playDecoderFromEnv } from './play-proof.ts';
import type { PlayerToken } from '../src/protocol.ts';

const player = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const otherPlayer = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;

const packageName = 'com.yardenzamir.tick3d';
const time = 1_800_000_000_000;
function verdict(nonce: string) {
  return { tokenPayloadExternal: {
    requestDetails: { nonce, requestPackageName: packageName, timestampMillis: String(time) },
    appIntegrity: { packageName, appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
  } };
}

describe('Play purchase proof', () => {
  it('accepts a licensed app once, also with concurrent submissions', async () => {
    let nonce = '';
    const proof = createPlayProof(async () => verdict(nonce), () => time);
    nonce = proof.nonce(player);
    const results = await Promise.allSettled([proof.verify('token', player), proof.verify('token', player)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });
  it('refuses another player without consuming the original player challenge', async () => {
    let nonce = '';
    const proof = createPlayProof(async () => verdict(nonce), () => time);
    nonce = proof.nonce(player);
    await expect(proof.verify('token', otherPlayer)).rejects.toMatchObject({ status: 403 });
    await expect(proof.verify('token', player)).resolves.toBe(true);
    await expect(proof.verify('token', player)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses old, invented and expired nonces', async () => {
    let now = time;
    let nonce = 'invented';
    const proof = createPlayProof(async () => verdict(nonce), () => now);
    await expect(proof.verify('token', player)).rejects.toMatchObject({ status: 403 });
    nonce = proof.nonce(player);
    now += 300_000;
    await expect(proof.verify('token', player)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['recognition', 'package', 'request package', 'timestamp', 'missing'])('refuses invalid %s', async (field) => {
    let nonce = '';
    const proof = createPlayProof(async () => {
      const result = verdict(nonce);
      const payload = result.tokenPayloadExternal;
      if (field === 'recognition') payload.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION';
      if (field === 'package') payload.appIntegrity.packageName = 'other.app';
      if (field === 'request package') payload.requestDetails.requestPackageName = 'other.app';
      if (field === 'timestamp') payload.requestDetails.timestampMillis = '0';
      return field === 'missing' ? {} : result;
    }, () => time);
    nonce = proof.nonce(player);
    await expect(proof.verify('token', player)).rejects.toMatchObject({ status: 403 });
  });
  it('returns a verified UNLICENSED verdict only to the nonce owner, once', async () => {
    let nonce = '';
    const proof = createPlayProof(async () => {
      const result = verdict(nonce);
      result.tokenPayloadExternal.accountDetails.appLicensingVerdict = 'UNLICENSED';
      return result;
    }, () => time);
    nonce = proof.nonce(player);
    await expect(proof.verify('negative', otherPlayer)).rejects.toMatchObject({ status: 403 });
    await expect(proof.verify('negative', player)).resolves.toBe(false);
    await expect(proof.verify('negative', player)).rejects.toMatchObject({ status: 403 });
  });
  it('refuses an UNEVALUATED verdict instead of returning a negative one', async () => {
    let nonce = '';
    const proof = createPlayProof(async () => {
      const result = verdict(nonce);
      result.tokenPayloadExternal.accountDetails.appLicensingVerdict = 'UNEVALUATED';
      return result;
    }, () => time);
    nonce = proof.nonce(player);
    await expect(proof.verify('unevaluated', player)).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed without credentials and rejects malformed configuration', async () => {
    expect(playDecoderFromEnv({})).toBeUndefined();
    expect(() => playDecoderFromEnv({ PLAY_SERVICE_ACCOUNT_JSON: '{}' })).toThrow();
    await expect(createPlayProof(undefined).verify('token', player)).rejects.toMatchObject({ status: 503 });
  });
  it('keeps a malformed secret out of the error message', () => {
    const secret = '{"private_key": "-----BEGIN PRIVATE KEY-----secret-part';
    let message = '';
    try {
      playDecoderFromEnv({ PLAY_SERVICE_ACCOUNT_JSON: secret });
    } catch (error) {
      message = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
    }
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain('secret-part');
    expect(message).not.toContain('PRIVATE KEY');
  });
});

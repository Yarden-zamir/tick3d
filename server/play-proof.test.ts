import { describe, expect, it } from 'vitest';
import { createPlayProof, playDecoderFromEnv } from './play-proof.ts';

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
    nonce = proof.nonce();
    const results = await Promise.allSettled([proof.verify('token'), proof.verify('token')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });
  it('refuses old, invented and expired nonces', async () => {
    let now = time;
    let nonce = 'invented';
    const proof = createPlayProof(async () => verdict(nonce), () => now);
    await expect(proof.verify('token')).rejects.toMatchObject({ status: 403 });
    nonce = proof.nonce();
    now += 300_000;
    await expect(proof.verify('token')).rejects.toMatchObject({ status: 403 });
  });
  it.each(['license', 'recognition', 'package', 'request package', 'timestamp', 'missing'])('refuses invalid %s', async (field) => {
    let nonce = '';
    const proof = createPlayProof(async () => {
      const result = verdict(nonce);
      const payload = result.tokenPayloadExternal;
      if (field === 'license') payload.accountDetails.appLicensingVerdict = 'UNLICENSED';
      if (field === 'recognition') payload.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION';
      if (field === 'package') payload.appIntegrity.packageName = 'other.app';
      if (field === 'request package') payload.requestDetails.requestPackageName = 'other.app';
      if (field === 'timestamp') payload.requestDetails.timestampMillis = '0';
      return field === 'missing' ? {} : result;
    }, () => time);
    nonce = proof.nonce();
    await expect(proof.verify('token')).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed without credentials and rejects malformed configuration', async () => {
    expect(playDecoderFromEnv({})).toBeUndefined();
    expect(() => playDecoderFromEnv({ PLAY_SERVICE_ACCOUNT_JSON: '{}' })).toThrow();
    await expect(createPlayProof(undefined).verify('token')).rejects.toMatchObject({ status: 503 });
  });
});

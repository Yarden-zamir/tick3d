import { describe, expect, it } from 'vitest';
import twaManifest from '../android/twa-manifest.json' with { type: 'json' };
import { assetLinks } from './assetlinks.ts';

const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

describe('assetLinks', () => {
  it('links the package of the Android app to its signing keys', () => {
    expect(assetLinks(twaManifest)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: twaManifest.packageId,
          sha256_cert_fingerprints: twaManifest.fingerprints.map(({ value }) => value),
        },
      },
    ]);
  });

  it('refuses a manifest that Android would reject', () => {
    expect(() => assetLinks({ packageId: 'a.b', fingerprints: [{ value: FINGERPRINT.toLowerCase() }] })).toThrow();
    expect(() => assetLinks({ packageId: 'a.b', fingerprints: [{ value: FINGERPRINT.slice(3) }] })).toThrow();
    expect(() => assetLinks({ packageId: 'a.b', fingerprints: [] })).toThrow();
    expect(() => assetLinks({ fingerprints: [{ value: FINGERPRINT }] })).toThrow();
  });
});

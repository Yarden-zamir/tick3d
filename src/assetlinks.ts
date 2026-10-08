// Digital Asset Links (/.well-known/assetlinks.json) for the Android app (android/twa-manifest.json).
// Android checks this file to open the site full screen in the app, without the browser bar.
// The package id and the signing key fingerprints come from the Bubblewrap manifest only,
// so the app and this file never disagree. The build (vite.config.ts) writes the file.
import { isRecord, isUnknownArray } from './guards.ts';

export const ASSET_LINKS_PATH = '.well-known/assetlinks.json';

// A SHA-256 certificate fingerprint as keytool and Play Console print it: 32 hex bytes with colons.
const isFingerprint = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.split(':').length === 32 &&
  value.split(':').every((byte) => byte.length === 2 && [...byte].every((char) => '0123456789ABCDEF'.includes(char)));

// Throws on a manifest without a package id or with a malformed fingerprint, so a typo fails the build
// and never reaches production as a file that Android rejects.
export function assetLinks(twaManifest: unknown): unknown[] {
  if (!isRecord(twaManifest)) throw new Error('twa-manifest.json is not an object');
  const { packageId, fingerprints } = twaManifest;
  if (typeof packageId !== 'string' || packageId === '') throw new Error('twa-manifest.json has no packageId');
  if (!isUnknownArray(fingerprints) || fingerprints.length === 0) throw new Error('twa-manifest.json has no fingerprints');
  const values = fingerprints.map((entry) => (isRecord(entry) ? entry.value : undefined));
  if (!values.every(isFingerprint)) throw new Error('a fingerprint in twa-manifest.json is not an uppercase SHA-256 with colons');
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: values },
    },
  ];
}

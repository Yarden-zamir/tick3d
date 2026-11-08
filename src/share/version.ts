// The two pages of /share. testing: the steps of the closed test (the Google Group, the Play testing link and
// TestFlight). general: the page for everyone, once the Android app is live on Google Play (GET /api/stores).
// Both keep the invite link and the free Google Play codes. share.html marks the parts of one page with data-only.
import type { PlayStage } from '../protocol.ts';

const SHARE_VERSIONS = ['testing', 'general'] as const;
export type ShareVersion = (typeof SHARE_VERSIONS)[number];

// The page that is known before the server answers, or undefined when the server decides. `search`: the query of the
// page, where `?version=testing` or `?version=general` opens that page, for a review. `remembered`: this browser
// learned before that the app is live, so the page for everyone shows at once, also when the server is out of reach.
export function knownVersion(search: string, remembered: boolean): ShareVersion | undefined {
  const asked = new URLSearchParams(search).get('version');
  const override = SHARE_VERSIONS.find((version) => version === asked);
  if (override !== undefined) return override;
  return remembered ? 'general' : undefined;
}

// The page that the answer of the server gives. `stage` is undefined when the server is out of reach: then the
// closed-test page shows, as before the launch.
export const versionOf = (stage: PlayStage | undefined): ShareVersion => (stage === 'live' ? 'general' : 'testing');

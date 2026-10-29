// A test seam for previews: `?unlocks=<n>` shows n achievements in the achievement popup when the page opens,
// and on the end card of each game. A reviewer sees a full unlock row without earning it.
// Only a preview (previewNumberOfHost) and the development server read it, so the live game ignores it.
import { ACHIEVEMENT_IDS, type AchievementId, rarestFirst } from '../achievements.ts';
import { previewNumberOfHost } from '../protocol.ts';

export function previewUnlocks(): AchievementId[] | undefined {
  if (!import.meta.env.DEV && previewNumberOfHost(location.hostname) === undefined) return undefined;
  const count = Number(new URL(location.href).searchParams.get('unlocks'));
  if (!Number.isInteger(count) || count < 1) return undefined;
  return rarestFirst(ACHIEVEMENT_IDS.slice(0, count));
}

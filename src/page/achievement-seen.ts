// The achievements that this device showed already: in the achievement popup (src/page/achievement-popup.ts)
// or on the end card of a game that this device played. The popup shows only the others.
import { ACHIEVEMENT_IDS, type AchievementId, type AchievementProgress } from '../achievements.ts';
import type { EpochMs } from '../epoch.ts';
import { isUnknownArray } from '../guards.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';

// Storage can hold anything: an id that is no achievement drops out, and a value that is no list is an empty set.
// On the first check of a device the set is empty, so every unlock pops, with the newest first (the popup caps the list).
export function parseSeen(value: unknown): ReadonlySet<AchievementId> {
  return new Set(isUnknownArray(value) ? ACHIEVEMENT_IDS.filter((id) => value.includes(id)) : []);
}

type Unlocked = AchievementProgress & { unlockedAt: EpochMs };

// The unlocked achievements that this device did not show yet, newest first.
export function unseenUnlocks(progress: readonly AchievementProgress[], seen: ReadonlySet<AchievementId>): Unlocked[] {
  return progress
    .filter((entry): entry is Unlocked => entry.unlockedAt !== null && !seen.has(entry.id))
    .toSorted((a, b) => b.unlockedAt - a.unlockedAt);
}

// The set of this visit, for a browser that blocks storage. Limit: such a browser shows the popup again on each
// visit. Revisit this if players report it.
let kept: ReadonlySet<AchievementId> = new Set();

export function loadSeen(): ReadonlySet<AchievementId> {
  try {
    return parseSeen(JSON.parse(localStorage.getItem(STORAGE_KEYS.achievementsSeen) ?? 'null'));
  } catch {
    return kept;
  }
}

// Adds `ids` to the seen set.
export function markSeen(ids: readonly AchievementId[]): void {
  const next = new Set([...loadSeen(), ...ids]);
  kept = next;
  try {
    localStorage.setItem(STORAGE_KEYS.achievementsSeen, JSON.stringify([...next]));
  } catch {
    // Storage is blocked or full: `kept` holds the set for this visit.
  }
}

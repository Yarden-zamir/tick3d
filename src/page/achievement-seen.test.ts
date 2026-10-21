import { describe, expect, it } from 'vitest';
import { type AchievementProgress, achievementProgress } from '../achievements.ts';
import { toEpochMs as ms } from '../epoch.ts';
import { parseSeen, unseenUnlocks } from './achievement-seen.ts';

// The progress with these achievements unlocked at these times.
function progress(unlocked: Record<string, number>): AchievementProgress[] {
  return achievementProgress([]).map((entry) => {
    const at = unlocked[entry.id];
    return at === undefined ? entry : { ...entry, count: 1, unlockedAt: ms(at) };
  });
}

describe('the seen set', () => {
  it('keeps known ids only, and reads anything else as an empty set', () => {
    expect(parseSeen(['first-win', 'not-an-achievement', 7, 'invite-1'])).toEqual(new Set(['first-win', 'invite-1']));
    for (const value of [[], null, undefined, 'first-win', { 'first-win': true }]) expect(parseSeen(value)).toEqual(new Set());
  });

  it('shows the unlocks that the device did not show, newest first', () => {
    const now = progress({ 'first-win': 10, 'invite-1': 30, 'games-10': 20 });
    expect(unseenUnlocks(now, new Set(['first-win'])).map((entry) => entry.id)).toEqual(['invite-1', 'games-10']);
    expect(unseenUnlocks(now, new Set(['first-win', 'invite-1', 'games-10']))).toEqual([]);
  });

  it('shows every unlock on the first run, and nothing locked', () => {
    const now = progress({ 'first-win': 10, 'invite-1': 30 });
    expect(unseenUnlocks(now, parseSeen(null)).map((entry) => entry.id)).toEqual(['invite-1', 'first-win']);
    expect(unseenUnlocks(progress({}), parseSeen(null))).toEqual([]);
  });
});

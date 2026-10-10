import { describe, expect, it } from 'vitest';
import { toEpochMs } from '../epoch.ts';
import type { LeaderboardRow, PersonId } from '../protocol.ts';
import { MIN_RATED_GAMES, defaultSort, sortRows } from './leaderboard-sort.ts';

const row = (name: string, fields: Partial<LeaderboardRow>): LeaderboardRow => ({
  person: name.padEnd(16, '0') as PersonId,
  name,
  player: null,
  games: 10,
  won: 5,
  drawn: 0,
  lost: 5,
  fastestWin: 9,
  avgMoves: 15,
  bestStreak: 2,
  lastPlayed: toEpochMs(1_000),
  ...fields,
});
const names = (rows: LeaderboardRow[]) => rows.map((found) => found.name);

describe('leaderboard order', () => {
  it('puts the most first, and the fewest first for the fastest win, with the players without a win last', () => {
    const rows = [row('a', { won: 2, fastestWin: 11 }), row('b', { won: 7, fastestWin: 7 }), row('c', { won: 4, fastestWin: null })];
    expect(names(sortRows(rows, defaultSort('won')))).toEqual(['b', 'c', 'a']);
    expect(names(sortRows(rows, defaultSort('fastestWin')))).toEqual(['b', 'a', 'c']);
    // The other way around keeps the players without a win last.
    expect(names(sortRows(rows, { key: 'fastestWin', lowFirst: false }))).toEqual(['a', 'b', 'c']);
  });

  it(`ranks win rate by the players with ${MIN_RATED_GAMES} games or more first`, () => {
    const lucky = row('lucky', { games: 1, won: 1, lost: 0 });
    const steady = row('steady', { games: MIN_RATED_GAMES, won: 4, lost: 1 });
    expect(names(sortRows([lucky, steady], defaultSort('winRate')))).toEqual(['steady', 'lucky']);
  });

  it('breaks a tie by more games, then by name', () => {
    const rows = [row('zed', { games: 10 }), row('amy', { games: 10 }), row('max', { games: 12, lost: 7 })];
    expect(names(sortRows(rows, defaultSort('won')))).toEqual(['max', 'amy', 'zed']);
  });
});

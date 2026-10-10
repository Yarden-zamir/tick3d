// The columns of the leaderboard (src/stats/leaderboard.ts) and the order of its rows. No DOM, so tests run it.
import type { LeaderboardRow } from '../protocol.ts';

type Column = {
  key: string;
  label: string;
  tip: string;
  // null sorts last in both directions.
  value: (row: LeaderboardRow) => number | null;
  show: (row: LeaderboardRow) => string;
  // Fewer is better: the fastest win and the shortest games.
  lowFirst?: boolean;
};

// Win rate ranks the players with at least this many games first, so one lucky game does not top the board.
export const MIN_RATED_GAMES = 5;
// The rows before "Show all".
export const SHOWN_ROWS = 25;

const rate = (row: LeaderboardRow) => (row.games === 0 ? 0 : row.won / row.games);
const whole = (value: number) => value.toLocaleString();

export const COLUMNS = [
  { key: 'games', label: 'Games', tip: 'Finished games', value: (row) => row.games, show: (row) => whole(row.games) },
  { key: 'won', label: 'Won', tip: 'Won games', value: (row) => row.won, show: (row) => whole(row.won) },
  { key: 'drawn', label: 'Drawn', tip: 'Draws: a full cube', value: (row) => row.drawn, show: (row) => whole(row.drawn) },
  { key: 'lost', label: 'Lost', tip: 'Lost games', value: (row) => row.lost, show: (row) => whole(row.lost) },
  {
    key: 'winRate',
    label: 'Win rate',
    tip: `Won games of all games. Players with fewer than ${MIN_RATED_GAMES} games come after the others.`,
    value: rate,
    show: (row) => `${Math.round(rate(row) * 100)}%`,
  },
  { key: 'bestStreak', label: 'Best streak', tip: 'The most wins in a row', value: (row) => row.bestStreak, show: (row) => whole(row.bestStreak) },
  {
    key: 'fastestWin',
    label: 'Fastest win',
    tip: 'The fewest moves of a game won with a line, both players together. A win on time does not count.',
    value: (row) => row.fastestWin,
    show: (row) => (row.fastestWin === null ? '–' : `${row.fastestWin} moves`),
    lowFirst: true,
  },
  {
    key: 'avgMoves',
    label: 'Avg moves',
    tip: 'The mean number of moves of a game',
    value: (row) => row.avgMoves,
    show: (row) => row.avgMoves.toLocaleString(undefined, { maximumFractionDigits: 1 }),
    lowFirst: true,
  },
  {
    key: 'lastPlayed',
    label: 'Last game',
    tip: 'When the last game ended',
    value: (row) => row.lastPlayed,
    show: (row) => new Date(row.lastPlayed).toLocaleDateString(),
  },
] as const satisfies readonly Column[];
export type SortKey = (typeof COLUMNS)[number]['key'];
export type Sort = { key: SortKey; lowFirst: boolean };

const columnOf = (key: SortKey): Column => {
  const found = COLUMNS.find((column) => column.key === key);
  if (found === undefined) throw new Error(`unknown leaderboard column ${key}`);
  return found;
};
export const defaultSort = (key: SortKey): Sort => ({ key, lowFirst: columnOf(key).lowFirst === true });

// The rows in the order of `sort`. Ties go to the player with more games, then by name.
export function sortRows(rows: readonly LeaderboardRow[], sort: Sort): LeaderboardRow[] {
  const { value } = columnOf(sort.key);
  const rated = (row: LeaderboardRow) => sort.key !== 'winRate' || row.games >= MIN_RATED_GAMES;
  return rows.toSorted((a, b) => {
    if (rated(a) !== rated(b)) return rated(a) ? -1 : 1;
    const x = value(a);
    const y = value(b);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return sort.lowFirst ? x - y : y - x;
    }
    return b.games - a.games || a.name.localeCompare(b.name);
  });
}

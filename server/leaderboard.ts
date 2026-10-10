// The SQL of the leaderboard (GET /api/leaderboard): the common stats of each person, from their side of
// each game. The store adds the names and the person ids, so no token leaves the server.
import { ACCOUNT_TOKEN_PREFIX, LEADERBOARD_ROWS, type StatsFilter } from '../src/protocol.ts';
import type { EpochMs } from '../src/epoch.ts';
import { COMPUTER_TOKEN } from '../src/session/core.ts';
import { type RowOf, type Rows, epoch, int, nullable, num, text } from './sql.ts';
import { FILTERED_GAMES, filterValues } from './stats.ts';

const LEADER = {
  owner: text,
  login: nullable(text),
  avatar: nullable(text),
  games: int,
  won: int,
  drawn: int,
  lost: int,
  fastest_win: nullable(int),
  avg_moves: num,
  best_streak: int,
  last_played: epoch,
};
export type LeaderRow = RowOf<typeof LEADER>;

// One row per seat of a person in a game. A friend game holds both seats on one device, so it has no side.
// `owner` is the canonical token: the account token of a linked device, else the device token.
// A person who hides their stats (private_stats) stays out.
// Limit: each call reads every result document. The store caches the answer per filter, like the stats.
// Revisit this when a call takes more than about 1 s.
const LEADERBOARD = `WITH g AS (${FILTERED_GAMES}),
  seats AS (
    SELECT finished_at, len(moves) AS moves, winner, ending, 'X' AS seat, player_x AS token FROM g WHERE player_x IS DISTINCT FROM player_o
    UNION ALL
    SELECT finished_at, len(moves) AS moves, winner, ending, 'O' AS seat, player_o AS token FROM g WHERE player_x IS DISTINCT FROM player_o
  ),
  played AS (
    -- A seat can hold the account token itself, which has no player_tokens row.
    SELECT coalesce($account || lpad(pt.github_id::VARCHAR, 16, '0'), token) AS owner,
      coalesce(pt.github_id, CASE WHEN starts_with(token, $account) THEN substr(token, length($account) + 1)::BIGINT END) AS github_id,
      finished_at, moves, ending,
      coalesce(winner = seat, false) AS won, winner IS NULL AS drawn
    FROM seats LEFT JOIN player_tokens pt USING (token)
    WHERE token IS NOT NULL AND token <> $computer
  ),
  shown AS (FROM played WHERE owner NOT IN (FROM private_stats SELECT owner)),
  -- A run counts the games since the last game that was not a win, so each run of wins has one number.
  runs AS (SELECT owner, won, sum(CASE WHEN won THEN 0 ELSE 1 END) OVER (PARTITION BY owner ORDER BY finished_at ROWS UNBOUNDED PRECEDING) AS run FROM shown),
  streaks AS (SELECT owner, max(wins)::INTEGER AS best_streak FROM (SELECT owner, run, count(*) FILTER (won) AS wins FROM runs GROUP BY owner, run) GROUP BY owner),
  totals AS (
    SELECT owner, any_value(github_id) AS github_id, count(*)::INTEGER AS games, count(*) FILTER (won)::INTEGER AS won,
      count(*) FILTER (drawn)::INTEGER AS drawn, count(*) FILTER (NOT won AND NOT drawn)::INTEGER AS lost,
      -- A win on time can come after any number of moves, so only a won line counts as a fast win.
      min(moves) FILTER (won AND ending = 'won')::INTEGER AS fastest_win, avg(moves) AS avg_moves, epoch_ms(max(finished_at)) AS last_played
    FROM shown GROUP BY owner
  )
SELECT owner, u.login, u.avatar, games, won, drawn, lost, fastest_win, avg_moves, best_streak, last_played
FROM totals JOIN streaks USING (owner) LEFT JOIN users u USING (github_id)
ORDER BY games DESC, won DESC, owner
LIMIT ${LEADERBOARD_ROWS}`;

export async function leaderRows(rows: Rows, filter: StatsFilter, now: EpochMs): Promise<LeaderRow[]> {
  return rows(LEADERBOARD, { ...filterValues(filter, null, now), account: ACCOUNT_TOKEN_PREFIX, computer: COMPUTER_TOKEN }, LEADER);
}

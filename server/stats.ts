// The aggregates of the public stats page (/stats), in DuckDB SQL. Everyone gets counts only: no
// names, no page faults. Mine adds the names of your opponents. The practice part (server/practice.ts)
// adds the Voice room leaderboard, which GET /api/practice/best shows too. Never a token, a result id or a game id leaves this file.
// An opponent without a login shows with a custom or a generated name.
import { type DuckDBValue, listValue } from '@duckdb/node-api';
import { DIFFICULTIES } from '../src/ai.ts';
import type { EpochMs } from '../src/epoch.ts';
import { isUnknownArray } from '../src/guards.ts';
import { CELL_COUNT } from '../src/game.ts';
import { nameOf } from '../src/names.ts';
import {
  type Count,
  FORM_WINDOW,
  MOVE_TIME_BUCKETS,
  type PersonalStats,
  RANGE_DAYS,
  type Refusal,
  REFUSALS,
  SESSION_MODES,
  type SideOutcome,
  type Stats,
  type StatsFilter,
} from '../src/protocol.ts';
import { type RowOf, type Rows, type Shape, bool, epoch, int, nullable, num, oneOf, text } from './sql.ts';


// The token of each seat of a result row. A row from before game links has no player columns:
// its uploader (`token`) holds the seat `doc.you`, or both seats in a friend game.
export const SEAT_X = `coalesce(results.player_x, CASE WHEN results.public_id IS NULL AND results.doc.you::VARCHAR IS DISTINCT FROM 'O' THEN results.token END)`;
export const SEAT_O = `coalesce(results.player_o, CASE WHEN results.public_id IS NULL AND results.doc.you::VARCHAR IS DISTINCT FROM 'X' THEN results.token END)`;

// One row per finished game that passes the filters, with the fields of its document as columns.
// Both devices of a Nearby game send a result, so only the host's row counts.
// The filters are bound parameters (filterValues): $since (epoch ms or null), $mode, $level, and
// $tokens (the tokens of one player for Mine, or null for Everyone). A null parameter filters nothing.
// `side` is the seat of the player whose results count: yours for Mine (null in a friend game, where
// you hold both seats), and the player's seat in a computer game for Everyone.
// computeStats copies these rows once into the temporary table stats_games, because each read of
// the VARIANT document is slow. Every query then reads the copy through GAMES.
// A row from before game links has no winner, ending or line columns. The game ended with its last
// move (a win) or on time, so the last mover won. Only a full cube can also be a draw: such an old
// game counts as a draw, and its winning line has no kind.
const FILTERED_GAMES = `FROM results SELECT
    finished_at,
    doc.mode::VARCHAR AS mode,
    doc.difficulty::VARCHAR AS level,
    doc.you::VARCHAR AS you,
    CASE WHEN doc.mode::VARCHAR = 'computer' THEN (CASE doc.you::VARCHAR WHEN 'X' THEN 'O' ELSE 'X' END) END AS computer,
    coalesce(doc.tuned::BOOLEAN, false) AS tuned,
    coalesce(doc.options.hideBoard::BOOLEAN, false) AS hide_board,
    coalesce(doc.options.hideHistory::BOOLEAN, false) AS hide_history,
    coalesce(doc.options.hideCoordinates::BOOLEAN, false) AS hide_coordinates,
    doc.game.moves::INTEGER[] AS moves,
    doc.game.times::DOUBLE[] AS times,
    doc.game.clock.perGame::INTEGER AS per_game,
    doc.game.clock.perMove::INTEGER AS per_move,
    coalesce(winner, CASE WHEN ending IS NULL AND (len(doc.game.moves::INTEGER[]) < 64 OR coalesce(doc.game.timedOut::BOOLEAN, false))
      THEN (CASE WHEN len(doc.game.moves::INTEGER[]) % 2 = 1 THEN 'X' ELSE 'O' END) END) AS winner,
    coalesce(ending, CASE WHEN coalesce(doc.game.timedOut::BOOLEAN, false) THEN 'timeout'
      WHEN len(doc.game.moves::INTEGER[]) < 64 THEN 'won' ELSE 'draw' END) AS ending,
    line, ${SEAT_X} AS player_x, ${SEAT_O} AS player_o, metrics, public_id,
    $tokens::VARCHAR[] IS NOT NULL AS scoped,
    coalesce(list_contains($tokens::VARCHAR[], ${SEAT_X}), false) AS mine_x,
    coalesce(list_contains($tokens::VARCHAR[], ${SEAT_O}), false) AS mine_o,
    coalesce(list_contains($tokens::VARCHAR[], results.token), false) AS mine_upload,
    CASE WHEN scoped THEN (CASE WHEN mine_x AND mine_o THEN NULL WHEN mine_x THEN 'X' WHEN mine_o THEN 'O' END)
      WHEN mode = 'computer' THEN you END AS side
  WHERE metrics.nearby.role::VARCHAR IS DISTINCT FROM 'guest'
    AND ($since::BIGINT IS NULL OR finished_at >= make_timestamptz($since::BIGINT * 1000))
    AND ($mode::VARCHAR IS NULL OR doc.mode::VARCHAR = $mode::VARCHAR)
    AND ($level::VARCHAR IS NULL OR doc.difficulty::VARCHAR = $level::VARCHAR)
    AND ($tokens::VARCHAR[] IS NULL OR list_contains($tokens::VARCHAR[], ${SEAT_X}) OR list_contains($tokens::VARCHAR[], ${SEAT_O}))`;
const GAMES_TABLE = 'stats_games';
const GAMES = `WITH g AS (FROM ${GAMES_TABLE})`;

// The time between two moves, by the player who moved. X makes the odd moves (1-based).
// The first move of a game has no time before it, so it is not here.
const STEPS = `${GAMES}, steps AS (
  SELECT mode, level, i, times[i] - times[i - 1] AS ms,
    CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END AS mover,
    CASE WHEN (CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END) = computer THEN 'computer' ELSE 'human' END AS who
  FROM (SELECT *, unnest(range(2, len(times) + 1)) AS i FROM g)
  WHERE times[i] - times[i - 1] > 0
)`;

// The metrics of every game that has them: device results, and each player of an online game.
// Mine keeps the reports of your own devices only. Every seat_metrics row has its game in results.
const METRICS = `${GAMES}, m AS (
  SELECT metrics FROM g WHERE metrics IS NOT NULL AND (NOT scoped OR mine_upload)
  UNION ALL
  SELECT sm.metrics FROM seat_metrics sm JOIN g USING (public_id)
  WHERE NOT g.scoped OR (sm.seat = 'X' AND g.mine_x) OR (sm.seat = 'O' AND g.mine_o)
)`;

// One identity per person: the GitHub account, else the browser token. Used only to group rows.
export const PERSON = `coalesce('github:' || pt.github_id, token)`;

// The columns that personName reads.
export const PERSON_COLUMNS = { login: nullable(text), custom: nullable(text), person: text };

// The GitHub login of a person (PERSON), else their custom name, else the generated name of their token.
// The token itself stays here. A query that uses it selects `login`, `custom` and `person`.
export const personName = (row: RowOf<typeof PERSON_COLUMNS>) => row.login ?? row.custom ?? nameOf(row.person);

// The rows of a count by key. A null key counts as 'unknown'.
const COUNT = { key: nullable(text), count: int };
const counts = (found: readonly RowOf<typeof COUNT>[]): Count[] => found.map((row) => ({ key: row.key ?? 'unknown', count: row.count }));

// A count for each of the 64 cells, from [cell, count] pairs.
function perCell(found: readonly (readonly [cell: number, count: number])[]): number[] {
  const cells = Array<number>(CELL_COUNT).fill(0);
  for (const [cell, count] of found) {
    if (cell < 0 || cell >= CELL_COUNT) throw new Error(`a stored move is not a cell: ${cell}`);
    cells[cell] = count;
  }
  return cells;
}

// At each game, the share of wins in the FORM_WINDOW games up to it. `games` is oldest first.
function formOf(games: readonly { at: EpochMs; outcome: SideOutcome }[]): Stats['form'] {
  let wins = 0;
  return games.map((game, i) => {
    if (game.outcome === 'won') wins++;
    const dropped = games[i - FORM_WINDOW];
    if (dropped?.outcome === 'won') wins--;
    return { at: game.at, rate: wins / Math.min(i + 1, FORM_WINDOW) };
  });
}

// The longest run of wins, and the run of equal results that ends with the newest game. Oldest first.
function streaksOf(outcomes: readonly SideOutcome[]): Pick<PersonalStats, 'bestStreak' | 'currentStreak'> {
  let best = 0;
  let run = 0;
  outcomes.forEach((outcome, i) => {
    run = i > 0 && outcomes[i - 1] === outcome ? run + 1 : 1;
    if (outcome === 'won') best = Math.max(best, run);
  });
  const last = outcomes.at(-1);
  return { bestStreak: best, currentStreak: last === undefined ? null : { outcome: last, length: run } };
}

// The bound values of the GAMES filters. `tokens` are the tokens of one player for Mine, else null.
function filterValues(filter: StatsFilter, tokens: readonly string[] | null, now: EpochMs): Record<string, DuckDBValue> {
  const days = RANGE_DAYS[filter.range];
  return {
    since: days === null ? null : now - days * 86_400_000,
    mode: filter.mode,
    level: filter.level,
    tokens: tokens === null ? null : listValue([...tokens]),
  };
}

// The newest games with a side that the form and the streaks read.
// Limit: the streaks count inside these games only. Revisit this when one player has more games than this.
const SIDED_GAMES = 5000;

// One read of the stored documents into stats_games, then about 25 small queries over that copy,
// while other requests wait in the store queue. The store keeps an Everyone answer for a minute.
// Limit: revisit this when a call takes more than about 1 s: then keep the game columns in results itself.
// `tokens`: the tokens of one player for the Mine scope, else null.
// The caller runs one call at a time on the connection (the store queue), so one temporary table is enough.
// The practice part comes from server/practice.ts.
export async function computeStats(rows: Rows, now: EpochMs, filter: StatsFilter, tokens: readonly string[] | null): Promise<Omit<Stats, 'practice'>> {
  if ((filter.scope === 'mine') !== (tokens !== null)) throw new Error('the Mine scope needs the tokens of the player, and only Mine takes them');
  await rows(`CREATE OR REPLACE TEMP TABLE ${GAMES_TABLE} AS ${FILTERED_GAMES}`, filterValues(filter, tokens, now), {});
  try {
    return await statsOfGames(rows, filter, tokens !== null, now);
  } finally {
    await rows(`DROP TABLE IF EXISTS ${GAMES_TABLE}`, {}, {});
  }
}

// A query without bound values.
type Query = <S extends Shape>(sql: string, shape: S) => Promise<RowOf<S>[]>;

async function statsOfGames(rows: Rows, filter: StatsFilter, mine: boolean, now: EpochMs): Promise<Omit<Stats, 'practice'>> {
  const q: Query = (sql, shape) => rows(sql, {}, shape);

  const [totals] = await q(`${GAMES}, seats AS (SELECT unnest([player_x, player_o]) AS token FROM g)
    SELECT
      (SELECT count(*) FROM g)::INTEGER AS games,
      (SELECT coalesce(sum(len(moves)), 0) FROM g)::INTEGER AS moves,
      (SELECT count(DISTINCT ${PERSON}) FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL)::INTEGER AS players,
      (SELECT count(*) FROM users)::INTEGER AS accounts,
      (SELECT count(*) FROM sessions)::INTEGER AS sessions,
      (SELECT count(*) FROM g WHERE finished_at >= now() - INTERVAL 7 DAY)::INTEGER AS last7`,
    { games: int, moves: int, players: int, accounts: int, sessions: int, last7: int },
  );
  if (totals === undefined) throw new Error('the totals query returned no row');

  // 60 days for all time.
  const days = RANGE_DAYS[filter.range] ?? 60;
  const perDay = await rows(`${GAMES},
    days AS (SELECT generate_series::DATE AS day FROM generate_series(current_date - to_days($days::INTEGER - 1), current_date::TIMESTAMP, INTERVAL 1 DAY)),
    seats AS (SELECT finished_at::DATE AS day, unnest([player_x, player_o]) AS token FROM g),
    people AS (SELECT day, count(DISTINCT ${PERSON}) AS players FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL GROUP BY day),
    played AS (SELECT finished_at::DATE AS day, count(*) AS games FROM g GROUP BY day)
    SELECT strftime(day, '%Y-%m-%d') AS day, coalesce(played.games, 0)::INTEGER AS games, coalesce(people.players, 0)::INTEGER AS players
    FROM days LEFT JOIN played USING (day) LEFT JOIN people USING (day) ORDER BY day`,
    { days },
    { day: text, games: int, players: int },
  );

  const hours = await q(`${GAMES} SELECT (isodow(finished_at) - 1)::INTEGER AS day, hour(finished_at)::INTEGER AS hour,
    count(*)::INTEGER AS games FROM g GROUP BY ALL`,
    { day: int, hour: int, games: int },
  );

  const byMode = await q(`${GAMES} SELECT mode AS key, count(*)::INTEGER AS count FROM g GROUP BY mode ORDER BY count DESC`, COUNT);

  const levels = await q(`${GAMES} SELECT level, count(*)::INTEGER AS games,
      count(*) FILTER (winner = you)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner = computer)::INTEGER AS lost,
      avg(len(moves)) AS avg_moves, median(len(moves)) AS median_moves,
      count(*) FILTER (tuned)::INTEGER AS tuned
    FROM g WHERE mode = 'computer' GROUP BY level`,
    { level: oneOf(DIFFICULTIES), games: int, won: int, drawn: int, lost: int, avg_moves: num, median_moves: num, tuned: int },
  );

  const lengthByMode = await q(`${GAMES} SELECT mode, count(*)::INTEGER AS games, avg(len(moves)) AS avg,
    median(len(moves)) AS median, quantile_cont(len(moves), 0.9) AS p90 FROM g GROUP BY mode ORDER BY games DESC`,
    { mode: oneOf(SESSION_MODES), games: int, avg: num, median: num, p90: num },
  );

  const moveTimes = await q(`${STEPS} SELECT
      CASE WHEN ms < 1000 THEN 0 WHEN ms < 2000 THEN 1 WHEN ms < 5000 THEN 2 WHEN ms < 10000 THEN 3
           WHEN ms < 30000 THEN 4 WHEN ms < 60000 THEN 5 WHEN ms < 300000 THEN 6 ELSE 7 END AS bucket,
      count(*) FILTER (who = 'human')::INTEGER AS human,
      count(*) FILTER (who = 'computer')::INTEGER AS computer
    FROM steps GROUP BY bucket ORDER BY bucket`,
    { bucket: int, human: int, computer: int },
  );

  const thinkTimes = await q(`${STEPS},
    timed AS (SELECT coalesce(level, mode) AS key, median(ms) FILTER (who = 'human') AS human_ms,
      median(ms) FILTER (who = 'computer') AS computer_ms FROM steps GROUP BY key),
    search AS (SELECT level AS key, median(t) AS search_ms
      FROM (SELECT level, unnest(metrics.thinkMs::DOUBLE[]) AS t FROM g WHERE mode = 'computer') GROUP BY level)
    SELECT key, human_ms, computer_ms, search_ms FROM timed LEFT JOIN search USING (key) ORDER BY key`,
    { key: text, human_ms: nullable(num), computer_ms: nullable(num), search_ms: nullable(num) },
  );

  const firstPlayer = await q(`${GAMES} SELECT mode, count(*) FILTER (winner = 'X')::INTEGER AS x,
    count(*) FILTER (winner = 'O')::INTEGER AS o, count(*) FILTER (winner IS NULL)::INTEGER AS draws
    FROM g GROUP BY mode ORDER BY mode`,
    { mode: oneOf(SESSION_MODES), x: int, o: int, draws: int },
  );

  const openings = await q(`${GAMES} SELECT moves[1] AS cell, count(*)::INTEGER AS count, count(*) FILTER (winner = 'X')::INTEGER AS x_wins
    FROM g WHERE len(moves) > 0 GROUP BY cell`,
    { cell: int, count: int, x_wins: int },
  );
  const lengths = await q(`${GAMES} SELECT len(moves)::INTEGER AS moves, count(*)::INTEGER AS count FROM g GROUP BY ALL`, { moves: int, count: int });
  const sided = await q(`${GAMES} SELECT epoch_ms(finished_at) AS at,
      CASE WHEN winner IS NULL THEN 'drawn' WHEN winner = side THEN 'won' ELSE 'lost' END AS outcome
    FROM g WHERE side IS NOT NULL ORDER BY finished_at DESC LIMIT ${SIDED_GAMES}`,
    { at: epoch, outcome: oneOf(['won', 'drawn', 'lost'] as const) },
  );
  const sidedGames = sided.toReversed();
  const cells = await q(`${GAMES} SELECT cell, count(*)::INTEGER AS count FROM (SELECT unnest(moves) AS cell FROM g) GROUP BY cell`, {
    cell: int,
    count: int,
  });
  const endings = await q(`${GAMES} SELECT coalesce(line, ending) AS key, count(*)::INTEGER AS count FROM g GROUP BY key ORDER BY count DESC`, COUNT);

  const hide = await q(`${GAMES} SELECT
      CASE WHEN hide_board AND hide_history THEN 'both' WHEN hide_board THEN 'board' WHEN hide_history THEN 'history' ELSE 'none' END AS setting,
      hide_coordinates AS coordinates,
      count(*)::INTEGER AS games,
      count(*) FILTER (mode = 'computer')::INTEGER AS computer_games,
      count(*) FILTER (mode = 'computer' AND winner = you)::INTEGER AS human_wins
    FROM g GROUP BY setting, coordinates ORDER BY games DESC`,
    { setting: oneOf(['none', 'board', 'history', 'both'] as const), coordinates: bool, games: int, computer_games: int, human_wins: int },
  );

  const timeLimits = await q(`${GAMES} SELECT per_game, per_move, count(*)::INTEGER AS games FROM g
    GROUP BY per_game, per_move ORDER BY games DESC LIMIT 8`,
    { per_game: nullable(int), per_move: nullable(int), games: int },
  );

  const tuned = await q(`${GAMES} SELECT tuned, count(*)::INTEGER AS games, count(*) FILTER (winner = you)::INTEGER AS human_wins
    FROM g WHERE mode = 'computer' GROUP BY tuned ORDER BY tuned`,
    { tuned: bool, games: int, human_wins: int },
  );

  // The field names are fixed here, never input, so they can go into the SQL text.
  const metricCounts = (field: string) =>
    q(`${METRICS} SELECT metrics.${field}::VARCHAR AS key, count(*)::INTEGER AS count FROM m GROUP BY key ORDER BY count DESC LIMIT 12`, COUNT);

  // One list column with a count per reason, in the order of REFUSALS.
  const refusalCounts = REFUSALS.map((reason) => `coalesce(sum(metrics.refused."${reason}"::INTEGER), 0)::INTEGER`).join(', ');
  const [usage] = await q(`${METRICS} SELECT count(*)::INTEGER AS games,
      coalesce(sum(metrics.input.board::INTEGER), 0)::INTEGER AS board,
      coalesce(sum(metrics.input.keypad::INTEGER), 0)::INTEGER AS keypad,
      coalesce(sum(metrics.undos::INTEGER), 0)::INTEGER AS undos,
      count(*) FILTER (metrics.undos::INTEGER > 0)::INTEGER AS games_with_undo,
      count(*) FILTER (metrics.offline::BOOLEAN)::INTEGER AS offline,
      [${refusalCounts}] AS refused
    FROM m`,
    { games: int, board: int, keypad: int, undos: int, games_with_undo: int, offline: int, refused: refusalList },
  );
  if (usage === undefined) throw new Error('the usage query returned no row');

  const nearbyMixes = await q(`${GAMES} SELECT
      array_to_string(list_sort([metrics.device::VARCHAR, coalesce(metrics.nearby.other::VARCHAR, 'unknown')]), ' + ') AS key,
      count(*)::INTEGER AS count
    FROM g WHERE mode = 'nearby' AND metrics.nearby.role::VARCHAR = 'host' GROUP BY key ORDER BY count DESC`,
    COUNT,
  );

  const personal = !mine ? null : await personalStats(q, sidedGames.map((game) => game.outcome));

  return {
    generatedAt: now,
    totals: {
      games: totals.games,
      moves: totals.moves,
      players: totals.players,
      accounts: totals.accounts,
      sessions: totals.sessions,
      gamesLast7Days: totals.last7,
    },
    perDay,
    hours,
    byMode: counts(byMode),
    levels: levels.map((row) => ({
      level: row.level,
      games: row.games,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,
      avgMoves: row.avg_moves,
      medianMoves: row.median_moves,
      tuned: row.tuned,
    })),
    lengthByMode,
    moveTimes: MOVE_TIME_BUCKETS.map((_, bucket) => {
      const row = moveTimes.find((found) => found.bucket === bucket);
      return { bucket, human: row?.human ?? 0, computer: row?.computer ?? 0 };
    }),
    thinkTimes: thinkTimes.map((row) => ({ key: row.key, humanMs: row.human_ms, computerMs: row.computer_ms, searchMs: row.search_ms })),
    firstPlayer,
    openings: perCell(openings.map((row) => [row.cell, row.count])),
    openingWinsX: perCell(openings.map((row) => [row.cell, row.x_wins])),
    cells: perCell(cells.map((row) => [row.cell, row.count])),
    endings: counts(endings),
    hide: hide.map((row) => ({
      setting: row.setting,
      coordinates: row.coordinates,
      games: row.games,
      computerGames: row.computer_games,
      humanWins: row.human_wins,
    })),
    timeLimits: timeLimits.map((row) => ({ perGame: row.per_game, perMove: row.per_move, games: row.games })),
    tuned: tuned.map((row) => ({ tuned: row.tuned, games: row.games, humanWins: row.human_wins })),
    metricsGames: usage.games,
    devices: counts(await metricCounts('device')),
    views: counts(await metricCounts('view')),
    layouts: counts(await metricCounts('layout')),
    themes: counts(await metricCounts('theme')),
    versions: counts(await metricCounts('version')),
    input: { board: usage.board, keypad: usage.keypad },
    refusals: usage.refused.filter((entry) => entry.count > 0),
    undo: { gamesWithUndo: usage.games_with_undo, undos: usage.undos },
    offlineGames: usage.offline,
    nearbyMixes: counts(nearbyMixes),
    filter,
    form: formOf(sidedGames),
    lengths: lengthCounts(lengths),
    personal,
  };
}

function lengthCounts(found: readonly { moves: number; count: number }[]): number[] {
  const counts = Array<number>(CELL_COUNT + 1).fill(0);
  for (const { moves, count } of found) {
    if (moves < 0 || moves > CELL_COUNT) throw new Error(`a stored game has ${moves} moves`);
    counts[moves] = count;
  }
  return counts;
}

// The `refused` column of the usage query: one count per reason, in the order of REFUSALS.
function refusalList(value: unknown): { key: Refusal; count: number }[] {
  if (!isUnknownArray(value) || value.length !== REFUSALS.length) throw new Error(`not ${REFUSALS.length} refusal counts`);
  return REFUSALS.map((key, i) => ({ key, count: int(value[i]) }));
}

// The results of one player (the Mine scope), from the side that they played. `outcomes` is oldest first.
async function personalStats(q: Query, outcomes: SideOutcome[]): Promise<PersonalStats> {
  const results = await q(`${GAMES} SELECT mode, level,
      count(*) FILTER (winner = side)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner <> side)::INTEGER AS lost
    FROM g WHERE side IS NOT NULL GROUP BY mode, level ORDER BY mode, level`,
    { mode: oneOf(SESSION_MODES), level: nullable(oneOf(DIFFICULTIES)), won: int, drawn: int, lost: int },
  );
  // The other seat of a game against a person. A Nearby guest on another device has no token, so it is not here.
  const opponents = await q(`${GAMES},
    other AS (SELECT CASE side WHEN 'X' THEN player_o ELSE player_x END AS token, winner, side
      FROM g WHERE side IS NOT NULL AND mode <> 'computer'),
    people AS (SELECT ${PERSON} AS person, any_value(u.login) AS login, any_value(pn.name) AS custom, count(*)::INTEGER AS games,
        count(*) FILTER (winner = side)::INTEGER AS won, count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
        count(*) FILTER (winner <> side)::INTEGER AS lost
      FROM other LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id
        LEFT JOIN player_names pn USING (token)
      WHERE token IS NOT NULL GROUP BY person)
    SELECT * FROM people ORDER BY games DESC, login NULLS LAST, person LIMIT 5`,
    { ...PERSON_COLUMNS, games: int, won: int, drawn: int, lost: int },
  );
  // Your survival records: per level, the most moves of a game that the default computer won.
  const survival = await q(`${GAMES} SELECT level, max(len(moves))::INTEGER AS moves
    FROM g WHERE mode = 'computer' AND side IS NOT NULL AND winner = computer AND NOT tuned GROUP BY level ORDER BY level`,
    { level: oneOf(DIFFICULTIES), moves: int },
  );
  return {
    survival,
    results,
    ...streaksOf(outcomes),
    opponents: opponents.map((row) => ({ player: personName(row), games: row.games, won: row.won, drawn: row.drawn, lost: row.lost })),
  };
}

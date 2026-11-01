// The aggregates of the public stats page (/stats), in DuckDB SQL. Everyone gets counts only: no
// names, no page faults. The leaderboard, which names players, is server/leaderboard.ts.
// Mine adds the names of your opponents. A person filter counts the games of one person, without their opponents. The practice part (server/practice.ts)
// adds the Voice room leaderboard, which GET /api/practice/best shows too. Never a token, a result id or a game id leaves this file.
// An opponent without a login shows with a custom or a generated name.
import type { DuckDBValue } from '@duckdb/node-api';
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
  RELEASE_ROWS,
  type Refusal,
  REFUSALS,
  SESSION_MODES,
  type SideOutcome,
  type Stats,
  type StatsFilter,
} from '../src/protocol.ts';
import { metricsStruct } from './fields.ts';
import { type RowOf, type Rows, type Shape, bool, epoch, int, nullable, num, oneOf, text } from './sql.ts';

// An ORDER BY term that lists a category in its fixed order, such as DIFFICULTIES or SESSION_MODES, so every
// table and chart lists it the same way. The values are constants of this code, never input.
const inOrder = (column: string, order: readonly string[]): string =>
  `list_position([${order.map((value) => `'${value}'`).join(', ')}], ${column})`;
const HIDE_SETTINGS = ['none', 'board', 'history', 'both'] as const;


// player_x and player_o hold the token of each seat of a result, or null for the computer and for a seat
// without a known player. Both columns have an index (server/store.ts), so the games of one player are a lookup.

// The bound values $t0, $t1, … of the tokens of one player, for inTokens and seatedResults.
export function tokenValues(tokens: readonly string[]): Record<string, string> {
  if (tokens.length === 0) throw new Error('a player has at least one token');
  return Object.fromEntries(tokens.map((token, index) => [`t${index}`, token]));
}

// `column IN ($t0, …)`. A list of bound values, not list_contains: then DuckDB uses the index of the column.
export const inTokens = (column: string, count: number): string => {
  if (count === 0) throw new Error('a player has at least one token');
  return `${column} IN (${Array.from({ length: count }, (_, index) => `$t${index}`).join(', ')})`;
};

// The rows of `table` where one of `count` tokens ($t0, …) holds a seat, through the indexes of the two seat
// columns. A row with the player on both seats (a friend game) comes once. Use it as `FROM ${...} <table>`.
// At 5,000,000 results this takes about 50 ms, where list_contains over every row takes over 1 s.
export const seatedRows = (table: string, seatX: string, seatO: string, count: number): string => `(FROM ${table} WHERE ${inTokens(seatX, count)}
  UNION ALL FROM ${table} WHERE ${inTokens(seatO, count)} AND (${seatX} IS NULL OR NOT ${inTokens(seatX, count)}))`;
export const seatedResults = (count: number): string => seatedRows('results', 'player_x', 'player_o', count);

// One row per finished game that passes the filters, with the fields of its document as columns.
// Both devices of a Nearby game send a result, so only the host's row counts.
// The filters are bound parameters (filterValues): $since (epoch ms or null), $mode and $level. A null parameter
// filters nothing. `tokens`: the number of tokens of one player ($t0, …) for Mine and a person filter, else null.
// `side` is the seat of the player whose results count: theirs for Mine and a person filter (null in a friend game, where
// you hold both seats), and the player's seat in a computer game for Everyone.
// The fields come from the plain columns of results (server/fields.ts), not from the document.
// computeStats reads these rows through stats_games and stats_sample (see STATS_SAMPLE).
// A row from before game links has no winner, ending or line columns. The game ended with its last
// move (a win) or on time, so the last mover won. Only a full cube can also be a draw: such an old
// game counts as a draw, and its winning line has no kind.
// The filter values as SQL: bound values by default, or literals for a view (literalFilter).
type FilterSql = { since: string; mode: string; level: string };
const BOUND_FILTER: FilterSql = { since: '$since::BIGINT', mode: '$mode::VARCHAR', level: '$level::VARCHAR' };

// The filters as SQL literals, for a view, which takes no bound values. Each value is a number or a checked name.
function literalFilter(filter: StatsFilter, now: EpochMs): FilterSql {
  const days = RANGE_DAYS[filter.range];
  const since = days === null ? null : now - days * 86_400_000;
  if (since !== null && !Number.isSafeInteger(since)) throw new Error('a stats filter time is not a whole number');
  if (filter.mode !== null && !SESSION_MODES.includes(filter.mode)) throw new Error('unknown stats mode');
  if (filter.level !== null && !DIFFICULTIES.includes(filter.level)) throw new Error('unknown stats level');
  return {
    since: since === null ? 'NULL::BIGINT' : `${since}::BIGINT`,
    mode: filter.mode === null ? 'NULL::VARCHAR' : `'${filter.mode}'`,
    level: filter.level === null ? 'NULL::VARCHAR' : `'${filter.level}'`,
  };
}

export const filteredGames = (tokens: number | null, where: FilterSql = BOUND_FILTER): string => `FROM ${tokens === null ? 'results' : `${seatedResults(tokens)} results`} SELECT
    finished_at,
    results.mode,
    results.level,
    results.you,
    CASE WHEN results.mode = 'computer' THEN (CASE results.you WHEN 'X' THEN 'O' ELSE 'X' END) END AS computer,
    coalesce(results.tuned, false) AS tuned,
    coalesce(results.hide_board, false) AS hide_board,
    coalesce(results.hide_history, false) AS hide_history,
    coalesce(results.hide_coordinates, false) AS hide_coordinates,
    results.moves,
    results.times,
    results.per_game,
    results.per_move,
    coalesce(winner, CASE WHEN ending IS NULL AND (len(results.moves) < 64 OR coalesce(results.timed_out, false))
      THEN (CASE WHEN len(results.moves) % 2 = 1 THEN 'X' ELSE 'O' END) END) AS winner,
    coalesce(ending, CASE WHEN coalesce(results.timed_out, false) THEN 'timeout'
      WHEN len(results.moves) < 64 THEN 'won' ELSE 'draw' END) AS ending,
    line, results.player_x, results.player_o, ${metricsStruct('results')} AS metrics, public_id,
    ${tokens !== null} AS scoped,
    ${tokens === null ? 'false' : `coalesce(${inTokens('results.player_x', tokens)}, false)`} AS mine_x,
    ${tokens === null ? 'false' : `coalesce(${inTokens('results.player_o', tokens)}, false)`} AS mine_o,
    ${tokens === null ? 'false' : inTokens('results.token', tokens)} AS mine_upload,
    CASE WHEN scoped THEN (CASE WHEN mine_x AND mine_o THEN NULL WHEN mine_x THEN 'X' WHEN mine_o THEN 'O' END)
      WHEN mode = 'computer' THEN you END AS side
  WHERE results.nearby_role IS DISTINCT FROM 'guest'
    AND (${where.since} IS NULL OR finished_at >= make_timestamptz(${where.since} * 1000))
    AND (${where.mode} IS NULL OR results.mode = ${where.mode})
    AND (${where.level} IS NULL OR results.level = ${where.level})`;
// Everyone: the exact counts read stats_games, a view over the columns of results. The charts of moves, times,
// settings and devices read stats_sample, a copy of the newest STATS_SAMPLE games, so their cost stops growing.
// Mine and a person filter: stats_games is a copy of the player's games, and stats_sample the same rows.
// Measured at 5,000,000 results: a copy of every game took 16 s and the move-time charts over it 40 s.
const STATS_SAMPLE = 100_000;
const DAY_MS = 86_400_000;
// NOT MATERIALIZED: a query that reads g twice must not copy the whole view of every game.
const GAMES = 'WITH g AS NOT MATERIALIZED (FROM stats_games)';
const SAMPLE = 'WITH g AS NOT MATERIALIZED (FROM stats_sample)';

// The time between two moves, by the player who moved. X makes the odd moves (1-based).
// The first move of a game has no time before it, so it is not here.
const STEPS = `${SAMPLE}, steps AS (
  SELECT mode, level, i, times[i] - times[i - 1] AS ms,
    CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END AS mover,
    CASE WHEN (CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END) = computer THEN 'computer' ELSE 'human' END AS who
  FROM (SELECT *, unnest(range(2, len(times) + 1)) AS i FROM g)
  WHERE times[i] - times[i - 1] > 0
)`;

// The metrics of every game that has them: device results, and each player of an online game.
// Mine keeps the reports of your own devices only. Every seat_metrics row has its game in results.
const METRICS = `${SAMPLE}, m AS (
  SELECT metrics FROM g WHERE metrics IS NOT NULL AND (NOT scoped OR mine_upload)
  UNION ALL
  SELECT ${metricsStruct('sm')} AS metrics FROM seat_metrics sm JOIN g USING (public_id)
  WHERE NOT g.scoped OR (sm.seat = 'X' AND g.mine_x) OR (sm.seat = 'O' AND g.mine_o)
)`;

// One identity per person: the GitHub account, else the browser token. Used only to group rows.
export const PERSON = `coalesce('github:' || pt.github_id, token)`;

// The columns that personName reads.
export const PERSON_COLUMNS = { account: nullable(text), custom: nullable(text), person: text };

// The name of the GitHub account of a person (PERSON, ACCOUNT_NAME), else the custom name of the device,
// else the generated name of their token. The token itself stays here. A query that uses it selects
// `account`, `custom` and `person`.
export const personName = (row: RowOf<typeof PERSON_COLUMNS>) => row.account ?? row.custom ?? nameOf(row.person);

// The name of an account (users u), as accountName in src/protocol.ts: the custom name, else the login.
export const ACCOUNT_NAME = 'coalesce(u.name, u.login)';

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
export function filterValues(filter: StatsFilter, tokens: readonly string[] | null, now: EpochMs): Record<string, DuckDBValue> {
  const days = RANGE_DAYS[filter.range];
  return {
    since: days === null ? null : now - days * 86_400_000,
    mode: filter.mode,
    level: filter.level,
    ...(tokens === null ? {} : tokenValues(tokens)),
  };
}

// The newest games with a side that the form and the streaks read.
// Limit: the streaks count inside these games only. Revisit this when one player has more games than this.
const SIDED_GAMES = 5000;

// About 25 queries over stats_games and stats_sample. Everyone runs on the reader connection of the store, in
// the background (snapshot in server/store.ts); Mine and a person filter run on the store queue.
// `tokens`: the tokens of one player for the Mine scope and a person filter, else null.
// The caller runs one call at a time on its connection, so one set of temporary tables is enough.
// The practice part comes from server/practice.ts.
// `sessions`: how many sessions exist. The live ones are in memory only (server/store.ts), so the store counts them.
export async function computeStats(rows: Rows, now: EpochMs, filter: StatsFilter, tokens: readonly string[] | null, sessions: number): Promise<Omit<Stats, 'practice' | 'person' | 'achievements'>> {
  const scoped = filter.scope === 'mine' || filter.person !== null;
  if (scoped !== (tokens !== null)) throw new Error('Mine and a person filter need the tokens of the player, and only they take them');
  if (tokens === null) {
    await rows(`CREATE OR REPLACE TEMP VIEW stats_games AS ${filteredGames(null, literalFilter(filter, now))}`, {}, {});
    // The time of the oldest sampled game first, from a narrow scan of finished_at. As a literal, it lets the
    // copy skip the old blocks of results and read the lists of the newest games only.
    const [oldest] = await rows(
      `SELECT epoch_ms(min(finished_at)) AS at FROM (SELECT finished_at FROM stats_games ORDER BY finished_at DESC LIMIT ${STATS_SAMPLE})`,
      {},
      { at: nullable(int) },
    );
    const since = oldest?.at ?? 0;
    if (!Number.isSafeInteger(since)) throw new Error('the oldest sampled game has no whole time');
    await rows(`CREATE OR REPLACE TEMP TABLE stats_sample AS FROM stats_games WHERE finished_at >= make_timestamptz(${since * 1000})`, {}, {});
  } else {
    await rows(`CREATE OR REPLACE TEMP TABLE stats_games AS ${filteredGames(tokens.length)}`, filterValues(filter, tokens, now), {});
    await rows('CREATE OR REPLACE TEMP VIEW stats_sample AS FROM stats_games', {}, {});
  }
  try {
    return await statsOfGames(rows, filter, scoped, now, sessions);
  } finally {
    await rows(tokens === null ? 'DROP TABLE IF EXISTS stats_sample' : 'DROP VIEW IF EXISTS stats_sample', {}, {});
    await rows(tokens === null ? 'DROP VIEW IF EXISTS stats_games' : 'DROP TABLE IF EXISTS stats_games', {}, {});
  }
}

// A query without bound values.
type Query = <S extends Shape>(sql: string, shape: S) => Promise<RowOf<S>[]>;

async function statsOfGames(rows: Rows, filter: StatsFilter, scoped: boolean, now: EpochMs, sessions: number): Promise<Omit<Stats, 'practice' | 'person' | 'achievements'>> {
  const q: Query = (sql, shape) => rows(sql, {}, shape);

  const [totals] = await q(`${GAMES}, seats AS (SELECT unnest([player_x, player_o]) AS token FROM g)
    SELECT
      (SELECT count(*) FROM g)::INTEGER AS games,
      (SELECT coalesce(sum(len(moves)), 0) FROM g)::INTEGER AS moves,
      (SELECT count(DISTINCT ${PERSON}) FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL)::INTEGER AS players,
      (SELECT count(*) FROM users)::INTEGER AS accounts,
      (SELECT count(*) FROM g WHERE finished_at >= now() - INTERVAL 7 DAY)::INTEGER AS last7`,
    { games: int, moves: int, players: int, accounts: int, last7: int },
  );
  if (totals === undefined) throw new Error('the totals query returned no row');

  // 60 days for all time. Days and hours come from epoch milliseconds in whole numbers: in UTC, and about
  // 10 times faster than the time zone math of isodow, hour and a cast to DATE on every row.
  const days = RANGE_DAYS[filter.range] ?? 60;
  const today = Math.floor(now / DAY_MS);
  const perDay = await rows(`${GAMES},
    recent AS NOT MATERIALIZED (FROM g SELECT epoch_ms(finished_at) // ${DAY_MS} AS d, player_x, player_o WHERE finished_at >= make_timestamptz($first * ${DAY_MS * 1000})),
    seats AS (SELECT d, unnest([player_x, player_o]) AS token FROM recent),
    people AS (SELECT d, count(DISTINCT ${PERSON}) AS players FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL GROUP BY d),
    played AS (SELECT d, count(*) AS games FROM recent GROUP BY d)
    SELECT range AS d, coalesce(played.games, 0)::INTEGER AS games, coalesce(people.players, 0)::INTEGER AS players
    FROM range($first, $today + 1) LEFT JOIN played ON played.d = range LEFT JOIN people ON people.d = range ORDER BY range`,
    { first: today - days + 1, today },
    { d: int, games: int, players: int },
  );

  // 1970-01-01 was a Thursday, so day number + 3 counts the weekdays from Monday (0).
  const hours = await q(`${GAMES} SELECT ((epoch_ms(finished_at) // ${DAY_MS} + 3) % 7)::INTEGER AS day,
    ((epoch_ms(finished_at) // 3600000) % 24)::INTEGER AS hour, count(*)::INTEGER AS games FROM g GROUP BY ALL`,
    { day: int, hour: int, games: int },
  );

  const byMode = await q(`${GAMES} SELECT mode AS key, count(*)::INTEGER AS count FROM g GROUP BY mode ORDER BY ${inOrder('mode', SESSION_MODES)}`, COUNT);

  const levels = await q(`${GAMES} SELECT level, count(*)::INTEGER AS games,
      count(*) FILTER (winner = you)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner = computer)::INTEGER AS lost,
      avg(len(moves)) AS avg_moves, median(len(moves)) AS median_moves,
      count(*) FILTER (tuned)::INTEGER AS tuned
    FROM g WHERE mode = 'computer' GROUP BY level ORDER BY ${inOrder('level', DIFFICULTIES)}`,
    { level: oneOf(DIFFICULTIES), games: int, won: int, drawn: int, lost: int, avg_moves: num, median_moves: num, tuned: int },
  );

  const lengthByMode = await q(`${SAMPLE} SELECT mode, count(*)::INTEGER AS games, avg(len(moves)) AS avg,
    median(len(moves)) AS median, quantile_cont(len(moves), 0.9) AS p90 FROM g GROUP BY mode ORDER BY ${inOrder('mode', SESSION_MODES)}`,
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
    SELECT key, human_ms, computer_ms, search_ms FROM timed LEFT JOIN search USING (key)
    ORDER BY ${inOrder('key', [...DIFFICULTIES, ...SESSION_MODES])}`,
    { key: text, human_ms: nullable(num), computer_ms: nullable(num), search_ms: nullable(num) },
  );

  const firstPlayer = await q(`${GAMES} SELECT mode, count(*) FILTER (winner = 'X')::INTEGER AS x,
    count(*) FILTER (winner = 'O')::INTEGER AS o, count(*) FILTER (winner IS NULL)::INTEGER AS draws
    FROM g GROUP BY mode ORDER BY ${inOrder('mode', SESSION_MODES)}`,
    { mode: oneOf(SESSION_MODES), x: int, o: int, draws: int },
  );

  const openings = await q(`${SAMPLE} SELECT moves[1] AS cell, count(*)::INTEGER AS count, count(*) FILTER (winner = 'X')::INTEGER AS x_wins
    FROM g WHERE len(moves) > 0 GROUP BY cell`,
    { cell: int, count: int, x_wins: int },
  );
  const lengths = await q(`${SAMPLE} SELECT len(moves)::INTEGER AS moves, count(*)::INTEGER AS count FROM g GROUP BY ALL`, { moves: int, count: int });
  const sided = await q(`${SAMPLE} SELECT epoch_ms(finished_at) AS at,
      CASE WHEN winner IS NULL THEN 'drawn' WHEN winner = side THEN 'won' ELSE 'lost' END AS outcome
    FROM g WHERE side IS NOT NULL ORDER BY finished_at DESC LIMIT ${SIDED_GAMES}`,
    { at: epoch, outcome: oneOf(['won', 'drawn', 'lost'] as const) },
  );
  const sidedGames = sided.toReversed();
  const cells = await q(`${SAMPLE} SELECT cell, count(*)::INTEGER AS count FROM (SELECT unnest(moves) AS cell FROM g) GROUP BY cell`, {
    cell: int,
    count: int,
  });
  const endings = await q(`${GAMES} SELECT coalesce(line, ending) AS key, count(*)::INTEGER AS count FROM g GROUP BY key ORDER BY count DESC`, COUNT);

  const hide = await q(`${SAMPLE} SELECT
      CASE WHEN hide_board AND hide_history THEN 'both' WHEN hide_board THEN 'board' WHEN hide_history THEN 'history' ELSE 'none' END AS setting,
      hide_coordinates AS coordinates,
      count(*)::INTEGER AS games,
      count(*) FILTER (mode = 'computer')::INTEGER AS computer_games,
      count(*) FILTER (mode = 'computer' AND winner = you)::INTEGER AS human_wins
    FROM g GROUP BY setting, coordinates ORDER BY ${inOrder('setting', HIDE_SETTINGS)}, coordinates`,
    { setting: oneOf(HIDE_SETTINGS), coordinates: bool, games: int, computer_games: int, human_wins: int },
  );

  const timeLimits = await q(`${SAMPLE} SELECT per_game, per_move, count(*)::INTEGER AS games FROM g
    GROUP BY per_game, per_move ORDER BY games DESC LIMIT 8`,
    { per_game: nullable(int), per_move: nullable(int), games: int },
  );

  const tuned = await q(`${SAMPLE} SELECT tuned, count(*)::INTEGER AS games, count(*) FILTER (winner = you)::INTEGER AS human_wins
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

  const nearbyMixes = await q(`${SAMPLE} SELECT
      array_to_string(list_sort([metrics.device::VARCHAR, coalesce(metrics.nearby.other::VARCHAR, 'unknown')]), ' + ') AS key,
      count(*)::INTEGER AS count
    FROM g WHERE mode = 'nearby' AND metrics.nearby.role::VARCHAR = 'host' GROUP BY key ORDER BY count DESC`,
    COUNT,
  );

  const [sampled] = await q(`${SAMPLE} SELECT count(*)::INTEGER AS games FROM g`, { games: int });

  // A person filter shows no opponents: those players did not choose to show up on another person's page.
  const personal = !scoped ? null : await personalStats(q, sidedGames.map((game) => game.outcome), filter.scope === 'mine');

  return {
    generatedAt: now,
    totals: {
      games: totals.games,
      moves: totals.moves,
      players: totals.players,
      accounts: totals.accounts,
      sessions,
      gamesLast7Days: totals.last7,
    },
    perDay: perDay.map((row) => ({ day: new Date(row.d * DAY_MS).toISOString().slice(0, 10), games: row.games, players: row.players })),
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
    sample: !scoped && totals.games > STATS_SAMPLE ? (sampled?.games ?? 0) : null,
    metricsGames: usage.games,
    devices: counts(await metricCounts('device')),
    views: counts(await metricCounts('view')),
    layouts: counts(await metricCounts('layout')),
    themes: counts(await metricCounts('theme')),
    releases: (await q(`${METRICS} SELECT coalesce(m.metrics.version::VARCHAR, 'unknown') AS version, any_value(r.name) AS name,
        epoch_ms(any_value(r.released_at)) AS released, count(*)::INTEGER AS count
      FROM m LEFT JOIN releases r ON r.version = m.metrics.version::VARCHAR
      GROUP BY 1 ORDER BY released DESC NULLS LAST, count DESC, version LIMIT ${RELEASE_ROWS}`,
      { version: text, name: nullable(text), released: nullable(epoch), count: int },
    )).map(({ version, name, released, count }) => ({ version, name, at: released, count })),
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

// The results of one player (Mine or a person filter), from the side that they played. `outcomes` is oldest first.
async function personalStats(q: Query, outcomes: SideOutcome[], withOpponents: boolean): Promise<PersonalStats> {
  const results = await q(`${GAMES} SELECT mode, level,
      count(*) FILTER (winner = side)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner <> side)::INTEGER AS lost
    FROM g WHERE side IS NOT NULL GROUP BY mode, level ORDER BY ${inOrder('mode', SESSION_MODES)}, ${inOrder('level', DIFFICULTIES)}`,
    { mode: oneOf(SESSION_MODES), level: nullable(oneOf(DIFFICULTIES)), won: int, drawn: int, lost: int },
  );
  // The other seat of a game against a person. A Nearby guest on another device has no token, so it is not here.
  const opponents = !withOpponents ? [] : await q(`${GAMES},
    other AS (SELECT CASE side WHEN 'X' THEN player_o ELSE player_x END AS token, winner, side
      FROM g WHERE side IS NOT NULL AND mode <> 'computer'),
    people AS (SELECT ${PERSON} AS person, any_value(${ACCOUNT_NAME}) AS account, any_value(pn.name) AS custom, count(*)::INTEGER AS games,
        count(*) FILTER (winner = side)::INTEGER AS won, count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
        count(*) FILTER (winner <> side)::INTEGER AS lost
      FROM other LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id
        LEFT JOIN player_names pn USING (token)
      WHERE token IS NOT NULL GROUP BY person)
    SELECT * FROM people ORDER BY games DESC, account NULLS LAST, person LIMIT 5`,
    { ...PERSON_COLUMNS, games: int, won: int, drawn: int, lost: int },
  );
  // Your survival records: per level, the most moves of a game that the default computer won.
  const survival = await q(`${GAMES} SELECT level, max(len(moves))::INTEGER AS moves
    FROM g WHERE mode = 'computer' AND side IS NOT NULL AND winner = computer AND NOT tuned GROUP BY level ORDER BY ${inOrder('level', DIFFICULTIES)}`,
    { level: oneOf(DIFFICULTIES), moves: int },
  );
  return {
    survival,
    results,
    ...streaksOf(outcomes),
    opponents: opponents.map((row) => ({ player: personName(row), games: row.games, won: row.won, drawn: row.drawn, lost: row.lost })),
  };
}

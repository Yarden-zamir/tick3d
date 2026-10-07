// The aggregates of the public stats page (/stats), in DuckDB SQL. Everyone gets counts only: no
// names, no page faults. Mine adds the names of your opponents. Never a token, a result id or a game id leaves this file.
// An opponent without a login shows with a custom or a generated name.
import { type DuckDBValue, listValue } from '@duckdb/node-api';
import { DIFFICULTIES } from '../src/ai.ts';
import { CELL_COUNT } from '../src/game.ts';
import { nameOf } from '../src/names.ts';
import {
  type Count,
  FORM_WINDOW,
  MOVE_TIME_BUCKETS,
  type PersonalStats,
  RANGE_DAYS,
  REFUSALS,
  SESSION_MODES,
  type SideOutcome,
  type Stats,
  type StatsFilter,
} from '../src/protocol.ts';

type Rows = (sql: string, values: Record<string, DuckDBValue>) => Promise<Record<string, unknown>[]>;

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
// A row from before game links has no winner, ending or line columns. The game ended with its last
// move (a win) or on time, so the last mover won. Only a full cube can also be a draw: such an old
// game counts as a draw, and its winning line has no kind.
const GAMES = `WITH g AS (
  FROM results SELECT
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
    AND ($tokens::VARCHAR[] IS NULL OR list_contains($tokens::VARCHAR[], ${SEAT_X}) OR list_contains($tokens::VARCHAR[], ${SEAT_O}))
)`;

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
const PERSON = `coalesce('github:' || pt.github_id, token)`;

function num(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error(`a stats value is not a number: ${String(value)}`);
  return result;
}

const numOrNull = (value: unknown) => (value === null ? null : num(value));
const text = (value: unknown) => {
  if (typeof value !== 'string') throw new Error(`a stats value is not text: ${String(value)}`);
  return value;
};
const textOrNull = (value: unknown) => (value === null ? null : text(value));
// The GitHub login of a person (PERSON), else their custom name, else the generated name of their token.
// The token itself stays here.
const personName = (row: Record<string, unknown>) => textOrNull(row.login) ?? textOrNull(row.custom) ?? nameOf(text(row.person));
const counts = (found: Record<string, unknown>[]): Count[] =>
  found.map((row) => ({ key: row.key === null ? 'unknown' : text(row.key), count: num(row.count) }));

function oneOf<T extends string>(options: readonly T[], value: unknown): T {
  const found = options.find((option) => option === value);
  if (found === undefined) throw new Error(`unexpected stats value ${String(value)}`);
  return found;
}

// A count for each of the 64 cells, from the column `column` of rows with a `cell`.
function perCell(found: Record<string, unknown>[], column = 'count'): number[] {
  const cells = Array<number>(CELL_COUNT).fill(0);
  for (const row of found) {
    const cell = num(row.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) throw new Error(`a stored move is not a cell: ${cell}`);
    cells[cell] = num(row[column]);
  }
  return cells;
}

const sideOutcome = (value: unknown) => oneOf(['won', 'drawn', 'lost'] as const, value);

// At each game, the share of wins in the FORM_WINDOW games up to it. `games` is oldest first.
function formOf(games: readonly { at: number; outcome: SideOutcome }[]): Stats['form'] {
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
function filterValues(filter: StatsFilter, tokens: readonly string[] | null, now: number): Record<string, DuckDBValue> {
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

// Limit: about 25 queries over every stored game, while other requests wait in the store queue.
// The store keeps an Everyone answer for a minute. Revisit this when a call takes more than about 200 ms:
// then keep daily totals in their own table.
// `tokens`: the tokens of one player for the Mine scope, else null.
export async function computeStats(rows: Rows, now: number, filter: StatsFilter, tokens: readonly string[] | null): Promise<Stats> {
  if ((filter.scope === 'mine') !== (tokens !== null)) throw new Error('the Mine scope needs the tokens of the player, and only Mine takes them');
  const values = filterValues(filter, tokens, now);
  const q = (sql: string) => rows(sql, values);

  const [totals] = await q(`${GAMES}, seats AS (SELECT unnest([player_x, player_o]) AS token FROM g)
    SELECT
      (SELECT count(*) FROM g)::INTEGER AS games,
      (SELECT coalesce(sum(len(moves)), 0) FROM g)::INTEGER AS moves,
      (SELECT count(DISTINCT ${PERSON}) FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL)::INTEGER AS players,
      (SELECT count(*) FROM users)::INTEGER AS accounts,
      (SELECT count(*) FROM sessions)::INTEGER AS sessions,
      (SELECT count(*) FROM g WHERE finished_at >= now() - INTERVAL 7 DAY)::INTEGER AS last7`);
  if (totals === undefined) throw new Error('the totals query returned no row');

  // 60 days for all time.
  const days = RANGE_DAYS[filter.range] ?? 60;
  const perDay = await rows(`${GAMES},
    days AS (SELECT generate_series::DATE AS day FROM generate_series(current_date - to_days($days::INTEGER - 1), current_date::TIMESTAMP, INTERVAL 1 DAY)),
    seats AS (SELECT finished_at::DATE AS day, unnest([player_x, player_o]) AS token FROM g),
    people AS (SELECT day, ${PERSON} AS person FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL)
    SELECT strftime(day, '%Y-%m-%d') AS day,
      (SELECT count(*) FROM g WHERE g.finished_at::DATE = days.day)::INTEGER AS games,
      (SELECT count(DISTINCT person) FROM people WHERE people.day = days.day)::INTEGER AS players
    FROM days ORDER BY day`, { ...values, days });

  const hours = await q(`${GAMES} SELECT (isodow(finished_at) - 1)::INTEGER AS day, hour(finished_at)::INTEGER AS hour,
    count(*)::INTEGER AS games FROM g GROUP BY ALL`);

  const byMode = await q(`${GAMES} SELECT mode AS key, count(*)::INTEGER AS count FROM g GROUP BY mode ORDER BY count DESC`);

  const levels = await q(`${GAMES} SELECT level, count(*)::INTEGER AS games,
      count(*) FILTER (winner = you)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner = computer)::INTEGER AS lost,
      avg(len(moves)) AS avg_moves, median(len(moves)) AS median_moves,
      count(*) FILTER (tuned)::INTEGER AS tuned
    FROM g WHERE mode = 'computer' GROUP BY level`);

  const lengthByMode = await q(`${GAMES} SELECT mode, count(*)::INTEGER AS games, avg(len(moves)) AS avg,
    median(len(moves)) AS median, quantile_cont(len(moves), 0.9) AS p90 FROM g GROUP BY mode ORDER BY games DESC`);

  const moveTimes = await q(`${STEPS} SELECT
      CASE WHEN ms < 1000 THEN 0 WHEN ms < 2000 THEN 1 WHEN ms < 5000 THEN 2 WHEN ms < 10000 THEN 3
           WHEN ms < 30000 THEN 4 WHEN ms < 60000 THEN 5 WHEN ms < 300000 THEN 6 ELSE 7 END AS bucket,
      count(*) FILTER (who = 'human')::INTEGER AS human,
      count(*) FILTER (who = 'computer')::INTEGER AS computer
    FROM steps GROUP BY bucket ORDER BY bucket`);

  const thinkTimes = await q(`${STEPS},
    timed AS (SELECT coalesce(level, mode) AS key, median(ms) FILTER (who = 'human') AS human_ms,
      median(ms) FILTER (who = 'computer') AS computer_ms FROM steps GROUP BY key),
    search AS (SELECT level AS key, median(t) AS search_ms
      FROM (SELECT level, unnest(metrics.thinkMs::DOUBLE[]) AS t FROM g WHERE mode = 'computer') GROUP BY level)
    SELECT key, human_ms, computer_ms, search_ms FROM timed LEFT JOIN search USING (key) ORDER BY key`);

  const firstPlayer = await q(`${GAMES} SELECT mode, count(*) FILTER (winner = 'X')::INTEGER AS x,
    count(*) FILTER (winner = 'O')::INTEGER AS o, count(*) FILTER (winner IS NULL)::INTEGER AS draws
    FROM g GROUP BY mode ORDER BY mode`);

  const openings = await q(`${GAMES} SELECT moves[1] AS cell, count(*)::INTEGER AS count, count(*) FILTER (winner = 'X')::INTEGER AS x_wins
    FROM g WHERE len(moves) > 0 GROUP BY cell`);
  const lengths = await q(`${GAMES} SELECT len(moves)::INTEGER AS moves, count(*)::INTEGER AS count FROM g GROUP BY ALL`);
  const sided = await q(`${GAMES} SELECT epoch_ms(finished_at) AS at,
      CASE WHEN winner IS NULL THEN 'drawn' WHEN winner = side THEN 'won' ELSE 'lost' END AS outcome
    FROM g WHERE side IS NOT NULL ORDER BY finished_at DESC LIMIT ${SIDED_GAMES}`);
  const sidedGames = sided.map((row) => ({ at: num(row.at), outcome: sideOutcome(row.outcome) })).toReversed();
  const cells = await q(`${GAMES} SELECT cell, count(*)::INTEGER AS count FROM (SELECT unnest(moves) AS cell FROM g) GROUP BY cell`);
  const endings = await q(`${GAMES} SELECT coalesce(line, ending) AS key, count(*)::INTEGER AS count FROM g GROUP BY key ORDER BY count DESC`);

  const hide = await q(`${GAMES} SELECT
      CASE WHEN hide_board AND hide_history THEN 'both' WHEN hide_board THEN 'board' WHEN hide_history THEN 'history' ELSE 'none' END AS setting,
      hide_coordinates AS coordinates,
      count(*)::INTEGER AS games,
      count(*) FILTER (mode = 'computer')::INTEGER AS computer_games,
      count(*) FILTER (mode = 'computer' AND winner = you)::INTEGER AS human_wins
    FROM g GROUP BY setting, coordinates ORDER BY games DESC`);

  const timeLimits = await q(`${GAMES} SELECT per_game, per_move, count(*)::INTEGER AS games FROM g
    GROUP BY per_game, per_move ORDER BY games DESC LIMIT 8`);

  const tuned = await q(`${GAMES} SELECT tuned, count(*)::INTEGER AS games, count(*) FILTER (winner = you)::INTEGER AS human_wins
    FROM g WHERE mode = 'computer' GROUP BY tuned ORDER BY tuned`);

  // The field names are fixed here, never input, so they can go into the SQL text.
  const metricCounts = (field: string) =>
    q(`${METRICS} SELECT metrics.${field}::VARCHAR AS key, count(*)::INTEGER AS count FROM m GROUP BY key ORDER BY count DESC LIMIT 12`);

  const refusalColumns = REFUSALS.map((reason, i) => `coalesce(sum(metrics.refused."${reason}"::INTEGER), 0)::INTEGER AS r${i}`).join(', ');
  const [usage] = await q(`${METRICS} SELECT count(*)::INTEGER AS games,
      coalesce(sum(metrics.input.board::INTEGER), 0)::INTEGER AS board,
      coalesce(sum(metrics.input.keypad::INTEGER), 0)::INTEGER AS keypad,
      coalesce(sum(metrics.undos::INTEGER), 0)::INTEGER AS undos,
      count(*) FILTER (metrics.undos::INTEGER > 0)::INTEGER AS games_with_undo,
      count(*) FILTER (metrics.offline::BOOLEAN)::INTEGER AS offline,
      ${refusalColumns}
    FROM m`);
  if (usage === undefined) throw new Error('the usage query returned no row');

  const nearbyMixes = await q(`${GAMES} SELECT
      array_to_string(list_sort([metrics.device::VARCHAR, coalesce(metrics.nearby.other::VARCHAR, 'unknown')]), ' + ') AS key,
      count(*)::INTEGER AS count
    FROM g WHERE mode = 'nearby' AND metrics.nearby.role::VARCHAR = 'host' GROUP BY key ORDER BY count DESC`);

  const personal = tokens === null ? null : await personalStats(q, sidedGames.map((game) => game.outcome));

  return {
    generatedAt: now,
    totals: {
      games: num(totals.games),
      moves: num(totals.moves),
      players: num(totals.players),
      accounts: num(totals.accounts),
      sessions: num(totals.sessions),
      gamesLast7Days: num(totals.last7),
    },
    perDay: perDay.map((row) => ({ day: text(row.day), games: num(row.games), players: num(row.players) })),
    hours: hours.map((row) => ({ day: num(row.day), hour: num(row.hour), games: num(row.games) })),
    byMode: counts(byMode),
    levels: levels.map((row) => ({
      level: oneOf(DIFFICULTIES, row.level),
      games: num(row.games),
      won: num(row.won),
      drawn: num(row.drawn),
      lost: num(row.lost),
      avgMoves: num(row.avg_moves),
      medianMoves: num(row.median_moves),
      tuned: num(row.tuned),
    })),
    lengthByMode: lengthByMode.map((row) => ({
      mode: oneOf(SESSION_MODES, row.mode),
      games: num(row.games),
      avg: num(row.avg),
      median: num(row.median),
      p90: num(row.p90),
    })),
    moveTimes: MOVE_TIME_BUCKETS.map((_, bucket) => {
      const row = moveTimes.find((found) => num(found.bucket) === bucket);
      return { bucket, human: row === undefined ? 0 : num(row.human), computer: row === undefined ? 0 : num(row.computer) };
    }),
    thinkTimes: thinkTimes.map((row) => ({
      key: text(row.key),
      humanMs: numOrNull(row.human_ms),
      computerMs: numOrNull(row.computer_ms),
      searchMs: numOrNull(row.search_ms),
    })),
    firstPlayer: firstPlayer.map((row) => ({ mode: oneOf(SESSION_MODES, row.mode), x: num(row.x), o: num(row.o), draws: num(row.draws) })),
    openings: perCell(openings),
    openingWinsX: perCell(openings, 'x_wins'),
    cells: perCell(cells),
    endings: counts(endings),
    hide: hide.map((row) => ({
      setting: oneOf(['none', 'board', 'history', 'both'] as const, row.setting),
      coordinates: row.coordinates === true,
      games: num(row.games),
      computerGames: num(row.computer_games),
      humanWins: num(row.human_wins),
    })),
    timeLimits: timeLimits.map((row) => ({ perGame: numOrNull(row.per_game), perMove: numOrNull(row.per_move), games: num(row.games) })),
    tuned: tuned.map((row) => ({ tuned: row.tuned === true, games: num(row.games), humanWins: num(row.human_wins) })),
    metricsGames: num(usage.games),
    devices: counts(await metricCounts('device')),
    views: counts(await metricCounts('view')),
    layouts: counts(await metricCounts('layout')),
    themes: counts(await metricCounts('theme')),
    versions: counts(await metricCounts('version')),
    input: { board: num(usage.board), keypad: num(usage.keypad) },
    refusals: REFUSALS.map((reason, i) => ({ key: reason, count: num(usage[`r${i}`]) })).filter((entry) => entry.count > 0),
    undo: { gamesWithUndo: num(usage.games_with_undo), undos: num(usage.undos) },
    offlineGames: num(usage.offline),
    nearbyMixes: counts(nearbyMixes),
    filter,
    form: formOf(sidedGames),
    lengths: lengthCounts(lengths),
    personal,
  };
}

function lengthCounts(found: Record<string, unknown>[]): number[] {
  const counts = Array<number>(CELL_COUNT + 1).fill(0);
  for (const row of found) {
    const moves = num(row.moves);
    if (!Number.isInteger(moves) || moves < 0 || moves > CELL_COUNT) throw new Error(`a stored game has ${moves} moves`);
    counts[moves] = num(row.count);
  }
  return counts;
}

// The results of one player (the Mine scope), from the side that they played. `outcomes` is oldest first.
async function personalStats(q: (sql: string) => Promise<Record<string, unknown>[]>, outcomes: SideOutcome[]): Promise<PersonalStats> {
  const results = await q(`${GAMES} SELECT mode, level,
      count(*) FILTER (winner = side)::INTEGER AS won,
      count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
      count(*) FILTER (winner <> side)::INTEGER AS lost
    FROM g WHERE side IS NOT NULL GROUP BY mode, level ORDER BY mode, level`);
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
    SELECT * FROM people ORDER BY games DESC, login NULLS LAST, person LIMIT 5`);
  // Your survival records: per level, the most moves of a game that the default computer won.
  const survival = await q(`${GAMES} SELECT level, max(len(moves))::INTEGER AS moves
    FROM g WHERE mode = 'computer' AND side IS NOT NULL AND winner = computer AND NOT tuned GROUP BY level ORDER BY level`);
  return {
    survival: survival.map((row) => ({ level: oneOf(DIFFICULTIES, row.level), moves: num(row.moves) })),
    results: results.map((row) => ({
      mode: oneOf(SESSION_MODES, row.mode),
      level: row.level === null ? null : oneOf(DIFFICULTIES, row.level),
      won: num(row.won),
      drawn: num(row.drawn),
      lost: num(row.lost),
    })),
    ...streaksOf(outcomes),
    opponents: opponents.map((row) => ({ player: personName(row), games: num(row.games), won: num(row.won), drawn: num(row.drawn), lost: num(row.lost) })),
  };
}

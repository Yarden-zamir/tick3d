//! The aggregates of the public stats page (server/stats.ts computeStats, and stats and statsCard in server/store.ts).
//! Everyone gets counts only. Mine adds the names of your opponents. A person filter counts the games of one person,
//! without their opponents. Never a token, a result id or a game id leaves this file.
use duckdb::{Connection, ToSql};
use serde_json::{Value, json};

use super::games::{seated_results, token_names, token_params};
use super::practice::{ACCOUNT_NAME, PERSON, person_name, practice_stats};
use super::{FROM_NODE, metric_lists};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{StatsFilter, StatsScope};

const CELL_COUNT: usize = 64;
/// Everyone: the charts of moves, times, settings and devices read a copy of the newest STATS_SAMPLE games.
const STATS_SAMPLE: i64 = 100_000;
const DAY_MS: i64 = 86_400_000;
/// The newest games with a side that the form and the streaks read.
/// Limit: the streaks count inside these games only. Revisit this when one player has more games than this.
const SIDED_GAMES: i64 = 5000;
const FORM_WINDOW: usize = 20;
const RELEASE_ROWS: i64 = 12;
const MOVE_TIME_BUCKETS: i64 = 8;
const SESSION_MODES: [&str; 4] = ["computer", "friend", "online", "nearby"];
const DIFFICULTIES: [&str; 3] = ["easy", "medium", "hard"];
const HIDE_SETTINGS: [&str; 4] = ["none", "board", "history", "both"];
// NOT MATERIALIZED: a query that reads g twice must not copy the whole view of every game.
const GAMES: &str = "WITH g AS NOT MATERIALIZED (FROM stats_games)";
const SAMPLE: &str = "WITH g AS NOT MATERIALIZED (FROM stats_sample)";

/// An ORDER BY term that lists a category in its fixed order. The values are constants of this code, never input.
fn in_order(column: &str, order: &[&str]) -> String {
    format!("list_position([{}], {column})", order.iter().map(|value| format!("'{value}'")).collect::<Vec<_>>().join(", "))
}

/// A number as JavaScript writes it: a whole number without ".0".
pub(super) fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 { json!(value as i64) } else { json!(value) }
}

fn js_option(value: Option<f64>) -> Value {
    value.map_or(Value::Null, js_number)
}

/// The filter values as SQL: bound values for Mine and a person, literals for the view of Everyone.
pub(super) struct FilterSql {
    since: String,
    mode: String,
    level: String,
}

pub(super) fn bound_filter() -> FilterSql {
    FilterSql { since: "$since::BIGINT".into(), mode: "$mode::VARCHAR".into(), level: "$level::VARCHAR".into() }
}

/// The time of the oldest game in the range, or None for all time.
pub(super) fn since_of(filter: &StatsFilter, now: i64) -> Option<i64> {
    filter.range.days().map(|days| now - days * DAY_MS)
}

/// The filters as SQL literals, for a view, which takes no bound values. Each value is a number or a checked name.
fn literal_filter(filter: &StatsFilter, now: i64) -> FilterSql {
    FilterSql {
        since: since_of(filter, now).map_or("NULL::BIGINT".into(), |since| format!("{since}::BIGINT")),
        mode: filter.mode.map_or("NULL::VARCHAR".into(), |mode| format!("'{}'", mode.as_str())),
        level: filter.level.map_or("NULL::VARCHAR".into(), |level| format!("'{}'", level.as_str())),
    }
}

/// `column IN ($t0, …)` (inTokens in server/stats.ts).
fn in_tokens(column: &str, count: usize) -> String {
    format!("{column} IN ({})", (0..count).map(|index| format!("$t{index}")).collect::<Vec<_>>().join(", "))
}

/// filteredGames in server/stats.ts: one row per finished game that passes the filters. `tokens`: the number of tokens of
/// one player for Mine and a person filter, else None. Both devices of a Nearby game send a result, so only the host's counts.
pub(super) fn filtered_games(tokens: Option<usize>, filter: &FilterSql) -> String {
    let (source, mine_x, mine_o, mine_upload) = match tokens {
        None => ("results".to_owned(), "false".to_owned(), "false".to_owned(), "false".to_owned()),
        Some(count) => (
            format!("{} results", seated_results(count)),
            format!("coalesce({}, false)", in_tokens("results.player_x", count)),
            format!("coalesce({}, false)", in_tokens("results.player_o", count)),
            in_tokens("results.token", count),
        ),
    };
    format!(
        "FROM {source} SELECT
           finished_at, results.mode, results.level, results.you,
           CASE WHEN results.mode = 'computer' THEN (CASE results.you WHEN 'X' THEN 'O' ELSE 'X' END) END AS computer,
           coalesce(results.tuned, false) AS tuned,
           coalesce(results.hide_board, false) AS hide_board,
           coalesce(results.hide_history, false) AS hide_history,
           coalesce(results.hide_coordinates, false) AS hide_coordinates,
           results.moves, results.times, results.per_game, results.per_move,
           coalesce(winner, CASE WHEN ending IS NULL AND (len(results.moves) < 64 OR coalesce(results.timed_out, false))
             THEN (CASE WHEN len(results.moves) % 2 = 1 THEN 'X' ELSE 'O' END) END) AS winner,
           coalesce(ending, CASE WHEN coalesce(results.timed_out, false) THEN 'timeout'
             WHEN len(results.moves) < 64 THEN 'won' ELSE 'draw' END) AS ending,
           line, results.player_x, results.player_o, {metrics} AS metrics, public_id,
           {scoped} AS scoped,
           {mine_x} AS mine_x,
           {mine_o} AS mine_o,
           {mine_upload} AS mine_upload,
           CASE WHEN scoped THEN (CASE WHEN mine_x AND mine_o THEN NULL WHEN mine_x THEN 'X' WHEN mine_o THEN 'O' END)
             WHEN mode = 'computer' THEN you END AS side
         WHERE results.nearby_role IS DISTINCT FROM 'guest'
           AND ({since} IS NULL OR finished_at >= make_timestamptz({since} * 1000))
           AND ({mode} IS NULL OR results.mode = {mode})
           AND ({level} IS NULL OR results.level = {level})",
        metrics = FROM_NODE.fields.metrics_of_results,
        scoped = tokens.is_some(),
        since = filter.since,
        mode = filter.mode,
        level = filter.level,
    )
}

/// Rows of a query without bound values.
fn rows<T>(conn: &Connection, sql: &str, map: impl FnMut(&duckdb::Row) -> duckdb::Result<T>) -> ApiResult<Vec<T>> {
    Ok(conn.prepare(sql)?.query_map([], map)?.collect::<duckdb::Result<Vec<T>>>()?)
}

fn one<T>(conn: &Connection, sql: &str, map: impl FnMut(&duckdb::Row) -> duckdb::Result<T>) -> ApiResult<T> {
    rows(conn, sql, map)?.into_iter().next().ok_or_else(|| ApiError::fault("a stats query returned no row"))
}

/// Count rows by key: a null key counts as 'unknown'.
fn counts(conn: &Connection, sql: &str) -> ApiResult<Value> {
    let found = rows(conn, sql, |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)))?;
    Ok(found.into_iter().map(|(key, count)| json!({ "key": key.unwrap_or_else(|| "unknown".into()), "count": count })).collect())
}

/// A count for each of the 64 cells, from (cell, count) pairs.
fn per_cell(found: impl IntoIterator<Item = (i64, i64)>) -> ApiResult<Vec<i64>> {
    let mut cells = vec![0; CELL_COUNT];
    for (cell, count) in found {
        let slot = usize::try_from(cell)
            .ok()
            .and_then(|cell| cells.get_mut(cell))
            .ok_or_else(|| ApiError::fault(format!("a stored move is not a cell: {cell}")))?;
        *slot = count;
    }
    Ok(cells)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SideOutcome {
    Won,
    Drawn,
    Lost,
}

impl SideOutcome {
    fn parse(text: &str) -> Option<SideOutcome> {
        match text {
            "won" => Some(SideOutcome::Won),
            "drawn" => Some(SideOutcome::Drawn),
            "lost" => Some(SideOutcome::Lost),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SideOutcome::Won => "won",
            SideOutcome::Drawn => "drawn",
            SideOutcome::Lost => "lost",
        }
    }
}

/// At each game, the share of wins in the FORM_WINDOW games up to it. `games` is oldest first.
fn form_of(games: &[(i64, SideOutcome)]) -> Value {
    let mut wins = 0;
    let mut form = Vec::with_capacity(games.len());
    for (i, (at, outcome)) in games.iter().enumerate() {
        if *outcome == SideOutcome::Won {
            wins += 1;
        }
        if i >= FORM_WINDOW && games[i - FORM_WINDOW].1 == SideOutcome::Won {
            wins -= 1;
        }
        form.push(json!({ "at": at, "rate": js_number(f64::from(wins) / (i + 1).min(FORM_WINDOW) as f64) }));
    }
    form.into()
}

/// The longest run of wins, and the run of equal results that ends with the newest game. Oldest first.
fn streaks_of(outcomes: &[SideOutcome]) -> (usize, Value) {
    let mut best = 0;
    let mut run = 0;
    for (i, outcome) in outcomes.iter().enumerate() {
        run = if i > 0 && outcomes[i - 1] == *outcome { run + 1 } else { 1 };
        if *outcome == SideOutcome::Won {
            best = best.max(run);
        }
    }
    let current = outcomes.last().map_or(Value::Null, |last| json!({ "outcome": last.as_str(), "length": run }));
    (best, current)
}

/// computeStats in server/store.ts: about 25 queries over stats_games and stats_sample. Everyone runs on the reader
/// connection; Mine and a person filter run on the store connection. The caller runs one call at a time on its
/// connection, so one set of temporary tables is enough. `tokens`: the tokens of one player for Mine and a person filter.
/// `sessions`: how many sessions exist. The answer has no `practice`, `person` and `achievements` yet.
pub(super) fn compute_stats(
    conn: &Connection,
    now: i64,
    filter: &StatsFilter,
    tokens: Option<&[String]>,
    sessions: usize,
) -> ApiResult<Value> {
    let scoped = filter.scope == StatsScope::Mine || filter.person.is_some();
    if scoped != tokens.is_some() {
        return Err(ApiError::fault("Mine and a person filter need the tokens of the player, and only they take them"));
    }
    match tokens {
        None => {
            conn.execute_batch(&format!(
                "CREATE OR REPLACE TEMP VIEW stats_games AS {}",
                filtered_games(None, &literal_filter(filter, now))
            ))?;
            // The time of the oldest sampled game first, from a narrow scan of finished_at. As a literal, it lets the copy
            // skip the old blocks of results.
            let oldest: Option<i64> = one(
                conn,
                &format!(
                    "SELECT epoch_ms(min(finished_at)) FROM (SELECT finished_at FROM stats_games ORDER BY finished_at DESC LIMIT {STATS_SAMPLE})"
                ),
                |row| row.get(0),
            )?;
            let since = oldest.unwrap_or(0);
            conn.execute_batch(&format!(
                "CREATE OR REPLACE TEMP TABLE stats_sample AS FROM stats_games WHERE finished_at >= make_timestamptz({})",
                since * 1000
            ))?;
        }
        Some(tokens) => {
            let names = token_names(tokens);
            let since = since_of(filter, now);
            let mode = filter.mode.map(|mode| mode.as_str());
            let level = filter.level.map(|level| level.as_str());
            let mut params = token_params(&names, tokens);
            params.extend([("since", &since as &dyn ToSql), ("mode", &mode as &dyn ToSql), ("level", &level as &dyn ToSql)]);
            conn.prepare(&format!("CREATE OR REPLACE TEMP TABLE stats_games AS {}", filtered_games(Some(tokens.len()), &bound_filter())))?
                .execute(params.as_slice())?;
            conn.execute_batch("CREATE OR REPLACE TEMP VIEW stats_sample AS FROM stats_games")?;
        }
    }
    let answer = stats_of_games(conn, filter, scoped, now, sessions);
    conn.execute_batch(if tokens.is_none() {
        "DROP TABLE IF EXISTS stats_sample; DROP VIEW IF EXISTS stats_games;"
    } else {
        "DROP VIEW IF EXISTS stats_sample; DROP TABLE IF EXISTS stats_games;"
    })?;
    let mut answer = answer?;
    answer["practice"] = serde_json::to_value(practice_stats(conn)?).map_err(ApiError::fault)?;
    Ok(answer)
}

fn stats_of_games(conn: &Connection, filter: &StatsFilter, scoped: bool, now: i64, sessions: usize) -> ApiResult<Value> {
    let modes = in_order("mode", &SESSION_MODES);
    let (games, moves, players, accounts, last7): (i64, i64, i64, i64, i64) = one(
        conn,
        &format!(
            "{GAMES}, seats AS (SELECT unnest([player_x, player_o]) AS token FROM g)
             SELECT
               (SELECT count(*) FROM g)::INTEGER,
               (SELECT coalesce(sum(len(moves)), 0) FROM g)::INTEGER,
               (SELECT count(DISTINCT {PERSON}) FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL)::INTEGER,
               (SELECT count(*) FROM users)::INTEGER,
               (SELECT count(*) FROM g WHERE finished_at >= now() - INTERVAL 7 DAY)::INTEGER"
        ),
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;

    // 60 days for all time. Days and hours come from epoch milliseconds in whole numbers, in UTC.
    let days = filter.range.days().unwrap_or(60);
    let today = now.div_euclid(DAY_MS);
    let first = today - days + 1;
    let per_day = rows(
        conn,
        &format!(
            "{GAMES},
             recent AS NOT MATERIALIZED (FROM g SELECT epoch_ms(finished_at) // {DAY_MS} AS d, player_x, player_o WHERE finished_at >= make_timestamptz({first} * {})),
             seats AS (SELECT d, unnest([player_x, player_o]) AS token FROM recent),
             people AS (SELECT d, count(DISTINCT {PERSON}) AS players FROM seats LEFT JOIN player_tokens pt USING (token) WHERE token IS NOT NULL GROUP BY d),
             played AS (SELECT d, count(*) AS games FROM recent GROUP BY d)
             SELECT range AS d, coalesce(played.games, 0)::INTEGER AS games, coalesce(people.players, 0)::INTEGER AS players
             FROM range({first}, {} + 1) LEFT JOIN played ON played.d = range LEFT JOIN people ON people.d = range ORDER BY range",
            DAY_MS * 1000,
            today
        ),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    )?
    .into_iter()
    .map(|(day, games, players)| {
        let date = chrono::DateTime::from_timestamp_millis(day * DAY_MS).expect("a stats day is a valid time").date_naive();
        json!({ "day": date.to_string(), "games": games, "players": players })
    })
    .collect::<Vec<_>>();

    // 1970-01-01 was a Thursday, so day number + 3 counts the weekdays from Monday (0).
    let hours: Vec<Value> = rows(
        conn,
        &format!(
            "{GAMES} SELECT ((epoch_ms(finished_at) // {DAY_MS} + 3) % 7)::INTEGER AS day,
               ((epoch_ms(finished_at) // 3600000) % 24)::INTEGER AS hour, count(*)::INTEGER AS games FROM g GROUP BY ALL"
        ),
        |row| Ok(json!({ "day": row.get::<_, i64>(0)?, "hour": row.get::<_, i64>(1)?, "games": row.get::<_, i64>(2)? })),
    )?;

    let by_mode = counts(conn, &format!("{GAMES} SELECT mode AS key, count(*)::INTEGER AS count FROM g GROUP BY mode ORDER BY {modes}"))?;

    let levels: Vec<Value> = rows(
        conn,
        &format!(
            "{GAMES} SELECT level, count(*)::INTEGER, count(*) FILTER (winner = you)::INTEGER, count(*) FILTER (winner IS NULL)::INTEGER,
               count(*) FILTER (winner = computer)::INTEGER, avg(len(moves)), median(len(moves)), count(*) FILTER (tuned)::INTEGER
             FROM g WHERE mode = 'computer' GROUP BY level ORDER BY {}",
            in_order("level", &DIFFICULTIES)
        ),
        |row| {
            Ok(json!({
                "level": row.get::<_, String>(0)?, "games": row.get::<_, i64>(1)?, "won": row.get::<_, i64>(2)?, "drawn": row.get::<_, i64>(3)?,
                "lost": row.get::<_, i64>(4)?, "avgMoves": js_number(row.get(5)?), "medianMoves": js_number(row.get(6)?), "tuned": row.get::<_, i64>(7)?,
            }))
        },
    )?;

    let length_by_mode: Vec<Value> = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT mode, count(*)::INTEGER, avg(len(moves)), median(len(moves)), quantile_cont(len(moves), 0.9)
             FROM g GROUP BY mode ORDER BY {modes}"
        ),
        |row| {
            Ok(json!({
                "mode": row.get::<_, String>(0)?, "games": row.get::<_, i64>(1)?, "avg": js_number(row.get(2)?),
                "median": js_number(row.get(3)?), "p90": js_number(row.get(4)?),
            }))
        },
    )?;

    // The time between two moves, by the player who moved. X makes the odd moves (1-based).
    let steps = format!(
        "{SAMPLE}, steps AS (
           SELECT mode, level, i, times[i] - times[i - 1] AS ms,
             CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END AS mover,
             CASE WHEN (CASE WHEN i % 2 = 1 THEN 'X' ELSE 'O' END) = computer THEN 'computer' ELSE 'human' END AS who
           FROM (SELECT *, unnest(range(2, len(times) + 1)) AS i FROM g)
           WHERE times[i] - times[i - 1] > 0
         )"
    );
    let buckets = rows(
        conn,
        &format!(
            "{steps} SELECT
               CASE WHEN ms < 1000 THEN 0 WHEN ms < 2000 THEN 1 WHEN ms < 5000 THEN 2 WHEN ms < 10000 THEN 3
                    WHEN ms < 30000 THEN 4 WHEN ms < 60000 THEN 5 WHEN ms < 300000 THEN 6 ELSE 7 END AS bucket,
               count(*) FILTER (who = 'human')::INTEGER, count(*) FILTER (who = 'computer')::INTEGER
             FROM steps GROUP BY bucket ORDER BY bucket"
        ),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    )?;
    let move_times: Vec<Value> = (0..MOVE_TIME_BUCKETS)
        .map(|bucket| {
            let (human, computer) = buckets.iter().find(|row| row.0 == bucket).map_or((0, 0), |row| (row.1, row.2));
            json!({ "bucket": bucket, "human": human, "computer": computer })
        })
        .collect();

    let all_keys: Vec<&str> = DIFFICULTIES.iter().chain(SESSION_MODES.iter()).copied().collect();
    let think_times: Vec<Value> = rows(
        conn,
        &format!(
            "{steps},
             timed AS (SELECT coalesce(level, mode) AS key, median(ms) FILTER (who = 'human') AS human_ms,
               median(ms) FILTER (who = 'computer') AS computer_ms FROM steps GROUP BY key),
             search AS (SELECT level AS key, median(t) AS search_ms
               FROM (SELECT level, unnest(metrics.thinkMs::DOUBLE[]) AS t FROM g WHERE mode = 'computer') GROUP BY level)
             SELECT key, human_ms, computer_ms, search_ms FROM timed LEFT JOIN search USING (key)
             ORDER BY {}",
            in_order("key", &all_keys)
        ),
        |row| {
            Ok(json!({
                "key": row.get::<_, String>(0)?, "humanMs": js_option(row.get(1)?), "computerMs": js_option(row.get(2)?), "searchMs": js_option(row.get(3)?),
            }))
        },
    )?;

    let first_player: Vec<Value> = rows(
        conn,
        &format!(
            "{GAMES} SELECT mode, count(*) FILTER (winner = 'X')::INTEGER, count(*) FILTER (winner = 'O')::INTEGER, count(*) FILTER (winner IS NULL)::INTEGER
             FROM g GROUP BY mode ORDER BY {modes}"
        ),
        |row| Ok(json!({ "mode": row.get::<_, String>(0)?, "x": row.get::<_, i64>(1)?, "o": row.get::<_, i64>(2)?, "draws": row.get::<_, i64>(3)? })),
    )?;

    let openings = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT moves[1] AS cell, count(*)::INTEGER, count(*) FILTER (winner = 'X')::INTEGER FROM g WHERE len(moves) > 0 GROUP BY cell"
        ),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    )?;
    let lengths = rows(conn, &format!("{SAMPLE} SELECT len(moves)::INTEGER, count(*)::INTEGER FROM g GROUP BY ALL"), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut length_counts = vec![0; CELL_COUNT + 1];
    for (moves, count) in lengths {
        let slot = usize::try_from(moves)
            .ok()
            .and_then(|moves| length_counts.get_mut(moves))
            .ok_or_else(|| ApiError::fault(format!("a stored game has {moves} moves")))?;
        *slot = count;
    }
    let mut sided = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT epoch_ms(finished_at), CASE WHEN winner IS NULL THEN 'drawn' WHEN winner = side THEN 'won' ELSE 'lost' END
             FROM g WHERE side IS NOT NULL ORDER BY finished_at DESC LIMIT {SIDED_GAMES}"
        ),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )?
    .into_iter()
    .map(|(at, outcome)| {
        SideOutcome::parse(&outcome).map(|outcome| (at, outcome)).ok_or_else(|| ApiError::fault("an unknown side outcome"))
    })
    .collect::<ApiResult<Vec<_>>>()?;
    sided.reverse();
    let cells =
        rows(conn, &format!("{SAMPLE} SELECT cell, count(*)::INTEGER FROM (SELECT unnest(moves) AS cell FROM g) GROUP BY cell"), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
    let endings = counts(
        conn,
        &format!("{GAMES} SELECT coalesce(line, ending) AS key, count(*)::INTEGER AS count FROM g GROUP BY key ORDER BY count DESC"),
    )?;

    let hide: Vec<Value> = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT
               CASE WHEN hide_board AND hide_history THEN 'both' WHEN hide_board THEN 'board' WHEN hide_history THEN 'history' ELSE 'none' END AS setting,
               hide_coordinates AS coordinates, count(*)::INTEGER, count(*) FILTER (mode = 'computer')::INTEGER,
               count(*) FILTER (mode = 'computer' AND winner = you)::INTEGER
             FROM g GROUP BY setting, coordinates ORDER BY {}, coordinates",
            in_order("setting", &HIDE_SETTINGS)
        ),
        |row| {
            Ok(json!({
                "setting": row.get::<_, String>(0)?, "coordinates": row.get::<_, bool>(1)?, "games": row.get::<_, i64>(2)?,
                "computerGames": row.get::<_, i64>(3)?, "humanWins": row.get::<_, i64>(4)?,
            }))
        },
    )?;

    let time_limits: Vec<Value> = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT per_game, per_move, count(*)::INTEGER AS games FROM g GROUP BY per_game, per_move ORDER BY games DESC LIMIT 8"
        ),
        |row| {
            Ok(
                json!({ "perGame": row.get::<_, Option<i64>>(0)?, "perMove": row.get::<_, Option<i64>>(1)?, "games": row.get::<_, i64>(2)? }),
            )
        },
    )?;

    let tuned: Vec<Value> = rows(
        conn,
        &format!(
            "{SAMPLE} SELECT tuned, count(*)::INTEGER, count(*) FILTER (winner = you)::INTEGER FROM g WHERE mode = 'computer' GROUP BY tuned ORDER BY tuned"
        ),
        |row| Ok(json!({ "tuned": row.get::<_, bool>(0)?, "games": row.get::<_, i64>(1)?, "humanWins": row.get::<_, i64>(2)? })),
    )?;

    // The metrics of every game that has them: device results, and each player of an online game.
    // Mine keeps the reports of your own devices only. Every seat_metrics row has its game in results.
    let metrics = format!(
        "{SAMPLE}, m AS (
           SELECT metrics FROM g WHERE metrics IS NOT NULL AND (NOT scoped OR mine_upload)
           UNION ALL
           SELECT {} AS metrics FROM seat_metrics sm JOIN g USING (public_id)
           WHERE NOT g.scoped OR (sm.seat = 'X' AND g.mine_x) OR (sm.seat = 'O' AND g.mine_o)
         )",
        FROM_NODE.fields.metrics_of_seat_metrics
    );
    // The field names are fixed here, never input.
    let metric_counts = |field: &str| {
        counts(
            conn,
            &format!(
                "{metrics} SELECT metrics.{field}::VARCHAR AS key, count(*)::INTEGER AS count FROM m GROUP BY key ORDER BY count DESC LIMIT 12"
            ),
        )
    };
    let refusals = metric_lists().refusals();
    let refusal_counts = refusals
        .iter()
        .map(|reason| format!("coalesce(sum(metrics.refused.\"{reason}\"::INTEGER), 0)::INTEGER"))
        .collect::<Vec<_>>()
        .join(", ");
    let (usage, refused): ([i64; 6], Vec<i64>) = one(
        conn,
        &format!(
            "{metrics} SELECT count(*)::INTEGER,
               coalesce(sum(metrics.input.board::INTEGER), 0)::INTEGER,
               coalesce(sum(metrics.input.keypad::INTEGER), 0)::INTEGER,
               coalesce(sum(metrics.undos::INTEGER), 0)::INTEGER,
               count(*) FILTER (metrics.undos::INTEGER > 0)::INTEGER,
               count(*) FILTER (metrics.offline::BOOLEAN)::INTEGER,
               {refusal_counts}
             FROM m"
        ),
        |row| {
            let usage = [row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?];
            Ok((usage, (0..refusals.len()).map(|i| row.get(6 + i)).collect::<duckdb::Result<Vec<i64>>>()?))
        },
    )?;
    let [metrics_games, board, keypad, undos, games_with_undo, offline] = usage;

    let nearby_mixes = counts(
        conn,
        &format!(
            "{SAMPLE} SELECT array_to_string(list_sort([metrics.device::VARCHAR, coalesce(metrics.nearby.other::VARCHAR, 'unknown')]), ' + ') AS key,
               count(*)::INTEGER AS count
             FROM g WHERE mode = 'nearby' AND metrics.nearby.role::VARCHAR = 'host' GROUP BY key ORDER BY count DESC"
        ),
    )?;
    let sampled: i64 = one(conn, &format!("{SAMPLE} SELECT count(*)::INTEGER FROM g"), |row| row.get(0))?;
    let releases: Vec<Value> = rows(
        conn,
        &format!(
            "{metrics} SELECT coalesce(m.metrics.version::VARCHAR, 'unknown') AS version, any_value(r.name) AS name,
               epoch_ms(any_value(r.released_at)) AS released, count(*)::INTEGER AS count
             FROM m LEFT JOIN releases r ON r.version = m.metrics.version::VARCHAR
             GROUP BY 1 ORDER BY released DESC NULLS LAST, count DESC, version LIMIT {RELEASE_ROWS}"
        ),
        |row| {
            Ok(
                json!({ "version": row.get::<_, String>(0)?, "name": row.get::<_, Option<String>>(1)?, "at": row.get::<_, Option<i64>>(2)?, "count": row.get::<_, i64>(3)? }),
            )
        },
    )?;

    // A person filter shows no opponents: those players did not choose to show up on another person's page.
    let outcomes: Vec<SideOutcome> = sided.iter().map(|(_, outcome)| *outcome).collect();
    let personal = if scoped { personal_stats(conn, &outcomes, filter.scope == StatsScope::Mine)? } else { Value::Null };

    Ok(json!({
        "generatedAt": now,
        "totals": { "games": games, "moves": moves, "players": players, "accounts": accounts, "sessions": sessions, "gamesLast7Days": last7 },
        "perDay": per_day,
        "hours": hours,
        "byMode": by_mode,
        "levels": levels,
        "lengthByMode": length_by_mode,
        "moveTimes": move_times,
        "thinkTimes": think_times,
        "firstPlayer": first_player,
        "openings": per_cell(openings.iter().map(|row| (row.0, row.1)))?,
        "openingWinsX": per_cell(openings.iter().map(|row| (row.0, row.2)))?,
        "cells": per_cell(cells)?,
        "endings": endings,
        "hide": hide,
        "timeLimits": time_limits,
        "tuned": tuned,
        "sample": if !scoped && games > STATS_SAMPLE { json!(sampled) } else { Value::Null },
        "metricsGames": metrics_games,
        "devices": metric_counts("device")?,
        "views": metric_counts("view")?,
        "layouts": metric_counts("layout")?,
        "themes": metric_counts("theme")?,
        "releases": releases,
        "input": { "board": board, "keypad": keypad },
        "refusals": refusals.iter().zip(refused).filter(|(_, count)| *count > 0).map(|(key, count)| json!({ "key": key, "count": count })).collect::<Vec<_>>(),
        "undo": { "gamesWithUndo": games_with_undo, "undos": undos },
        "offlineGames": offline,
        "nearbyMixes": nearby_mixes,
        "filter": filter,
        "form": form_of(&sided),
        "lengths": length_counts,
        "personal": personal,
    }))
}

/// The results of one player (Mine or a person filter), from the side that they played. `outcomes` is oldest first.
fn personal_stats(conn: &Connection, outcomes: &[SideOutcome], with_opponents: bool) -> ApiResult<Value> {
    let results: Vec<Value> = rows(
        conn,
        &format!(
            "{GAMES} SELECT mode, level, count(*) FILTER (winner = side)::INTEGER, count(*) FILTER (winner IS NULL)::INTEGER,
               count(*) FILTER (winner <> side)::INTEGER
             FROM g WHERE side IS NOT NULL GROUP BY mode, level ORDER BY {}, {}",
            in_order("mode", &SESSION_MODES),
            in_order("level", &DIFFICULTIES)
        ),
        |row| {
            Ok(json!({
                "mode": row.get::<_, String>(0)?, "level": row.get::<_, Option<String>>(1)?, "won": row.get::<_, i64>(2)?,
                "drawn": row.get::<_, i64>(3)?, "lost": row.get::<_, i64>(4)?,
            }))
        },
    )?;
    // The other seat of a game against a person. A Nearby guest on another device has no token, so it is not here.
    let opponents: Vec<Value> = if !with_opponents {
        Vec::new()
    } else {
        rows(
            conn,
            &format!(
                "{GAMES},
                 other AS (SELECT CASE side WHEN 'X' THEN player_o ELSE player_x END AS token, winner, side
                   FROM g WHERE side IS NOT NULL AND mode <> 'computer'),
                 people AS (SELECT {PERSON} AS person, any_value({ACCOUNT_NAME}) AS account, any_value(pn.name) AS custom, count(*)::INTEGER AS games,
                     count(*) FILTER (winner = side)::INTEGER AS won, count(*) FILTER (winner IS NULL)::INTEGER AS drawn,
                     count(*) FILTER (winner <> side)::INTEGER AS lost
                   FROM other LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id
                     LEFT JOIN player_names pn USING (token)
                   WHERE token IS NOT NULL GROUP BY person)
                 SELECT account, custom, person, games, won, drawn, lost FROM people ORDER BY games DESC, account NULLS LAST, person LIMIT 5"
            ),
            |row| {
                let person: String = row.get(2)?;
                Ok(json!({
                    "player": person_name(row.get(0)?, row.get(1)?, &person), "games": row.get::<_, i64>(3)?, "won": row.get::<_, i64>(4)?,
                    "drawn": row.get::<_, i64>(5)?, "lost": row.get::<_, i64>(6)?,
                }))
            },
        )?
    };
    // Your survival records: per level, the most moves of a game that the default computer won.
    let survival: Vec<Value> = rows(
        conn,
        &format!(
            "{GAMES} SELECT level, max(len(moves))::INTEGER FROM g WHERE mode = 'computer' AND side IS NOT NULL AND winner = computer AND NOT tuned
             GROUP BY level ORDER BY {}",
            in_order("level", &DIFFICULTIES)
        ),
        |row| Ok(json!({ "level": row.get::<_, String>(0)?, "moves": row.get::<_, i64>(1)? })),
    )?;
    let (best, current) = streaks_of(outcomes);
    Ok(json!({ "survival": survival, "results": results, "bestStreak": best, "currentStreak": current, "opponents": opponents }))
}

/// Whose stats these are, for a person filter (StatsPerson in src/protocol.ts). `you`: the caller is this person.
#[derive(serde::Serialize)]
pub struct ShownPerson {
    name: String,
    player: Option<tick3d_core::session::PlayerInfo>,
    you: bool,
}

/// GET /api/stats/card/{person}: the player card of a person view. `unlocked` holds the unlocked achievements, newest first.
#[derive(serde::Serialize)]
pub struct StatsCard {
    person: ShownPerson,
    unlocked: Vec<String>,
}

const STATS_PRIVATE_MESSAGE: &str = "This player keeps their stats private.";

impl super::Db {
    /// How many sessions exist. The live ones are in memory only, so the store counts them.
    pub fn session_count(&self) -> usize {
        self.sessions.known_count()
    }

    /// The person of a person view, for the caller `token`: 403 when the person hides their stats from the caller, 404
    /// without an account and a finished game (visiblePersonOf in server/store.ts).
    fn visible_person_of(&mut self, person: &str, token: Option<&str>) -> ApiResult<(super::moderation::StatsPerson, ShownPerson)> {
        let hidden: Option<String> = self
            .query(
                &format!(
                    "FROM private_stats SELECT owner WHERE left(sha256($prefix || owner), {}) = $person",
                    crate::ids::PERSON_ID_LENGTH
                ),
                &[("prefix", &crate::ids::PERSON_ID_PREFIX), ("person", &person)],
                |row| row.get(0),
            )?
            .into_iter()
            .next();
        let caller = token.map(|token| self.owner_of(token)).transpose()?;
        if hidden.is_some() && caller != hidden {
            return Err(ApiError::new(axum::http::StatusCode::FORBIDDEN, STATS_PRIVATE_MESSAGE));
        }
        let found = self
            .stats_person_of(person)?
            .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "This player has no finished games yet."))?;
        let shown = ShownPerson { name: found.name.clone(), player: found.player.clone(), you: caller.as_ref() == Some(&found.owner) };
        Ok((found, shown))
    }

    /// The stats of Mine (`token` is the player) or of a person filter. They have no cache, so a game shows at once.
    /// Limit: each call runs all queries on the store thread. Revisit this when such a call takes more than about 200 ms.
    pub fn scoped_stats(&mut self, filter: &StatsFilter, token: Option<&str>) -> ApiResult<Value> {
        let sessions = self.session_count();
        let now = super::now_ms();
        let (owner, tokens, person) = match (&filter.person, filter.scope) {
            (None, StatsScope::Mine) => {
                let token = token.ok_or_else(|| ApiError::bad_request("Your stats need the X-Player header."))?;
                let tokens: Vec<String> = self.identity_of(Some(token))?.into_iter().collect();
                (self.owner_of(token)?, tokens, Value::Null)
            }
            (Some(person), _) => {
                let (found, shown) = self.visible_person_of(person, token)?;
                (found.owner, found.tokens, serde_json::to_value(shown).map_err(ApiError::fault)?)
            }
            (None, StatsScope::Everyone) => return Err(ApiError::fault("the Everyone stats come from a snapshot")),
        };
        let mut answer = compute_stats(&self.conn, now, filter, Some(&tokens), sessions)?;
        answer["person"] = person;
        answer["achievements"] = serde_json::to_value(self.achievements_of(&owner, &tokens)?).map_err(ApiError::fault)?;
        Ok(answer)
    }

    /// The player card of a person view: the name, and the unlocks of achievement_players, newest first. It reads no game.
    pub fn stats_card(&mut self, person: &str, token: Option<&str>) -> ApiResult<StatsCard> {
        let (found, shown) = self.visible_person_of(person, token)?;
        self.refresh_achievements()?;
        let unlocked: Option<String> = self
            .query("FROM achievement_players SELECT to_json(unlocked)::VARCHAR WHERE owner = $owner", &[("owner", &found.owner)], |row| {
                row.get(0)
            })?
            .into_iter()
            .next();
        let unlocked: Vec<String> = match unlocked {
            None => Vec::new(),
            Some(text) => serde_json::from_str(&text).map_err(ApiError::fault)?,
        };
        if let Some(unknown) = unlocked.iter().find(|id| !crate::achievements::is_id(id)) {
            return Err(ApiError::fault(format!("achievement_players holds the unknown achievement {unknown}")));
        }
        Ok(StatsCard { person: shown, unlocked })
    }
}

/// The Everyone stats on the reader connection, for a snapshot (stats in server/store.ts).
pub fn everyone_stats(conn: &Connection, filter: &StatsFilter, sessions: usize) -> ApiResult<Value> {
    let mut answer = compute_stats(conn, super::now_ms(), filter, None, sessions)?;
    answer["person"] = Value::Null;
    answer["achievements"] = Value::Null;
    Ok(answer)
}

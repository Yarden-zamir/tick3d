//! The stats of one player (Mine or a person filter), counted in Rust. The SQL path of store/stats.rs runs about 30
//! statements of 10 to 40 ms each over a temporary table; this path reads the player's games once through the same
//! `filtered_games` source, adds a few small lookups, and counts in memory. The answer has the same shape. A test runs
//! both on the same data and compares them, so the two cannot drift.
use std::collections::{BTreeMap, HashMap, HashSet};

use duckdb::{Connection, ToSql};
use serde_json::{Value, json};

use super::games::{token_names, token_params};
use super::practice::person_name;
use super::stats::{
    CELL_COUNT, DAY_MS, DIFFICULTIES, FilterSql, HIDE_SETTINGS, MOVE_TIME_BUCKETS, RELEASE_ROWS, SESSION_MODES, SIDED_GAMES, SideOutcome,
    bound_filter, filtered_games, form_of, js_number, js_option, per_cell, since_of, streaks_of,
};
use super::{FROM_NODE, json_list, metric_lists};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{StatsFilter, StatsScope};

/// A time limit: per game, then per move, in seconds.
type TimeLimit = (Option<i64>, Option<i64>);
/// A row of the player's results: mode, level, then won, drawn and lost.
type ResultRow = (String, Option<String>, [i64; 3]);
/// An opponent: the person key, the account name, the custom name, then games, won, drawn and lost.
type OpponentRow = (String, Option<String>, Option<String>, [i64; 4]);

/// One game of the player, from `filtered_games`.
struct Game {
    finished: i64,
    mode: String,
    level: Option<String>,
    you: Option<String>,
    computer: Option<String>,
    tuned: bool,
    hide_board: bool,
    hide_history: bool,
    hide_coordinates: bool,
    moves: Vec<i64>,
    /// DOUBLE[] in results: the copied columns keep the JSON numbers.
    times: Vec<f64>,
    per_game: Option<i64>,
    per_move: Option<i64>,
    winner: Option<String>,
    ending: String,
    line: Option<String>,
    player_x: Option<String>,
    player_o: Option<String>,
    metrics: Option<Value>,
    public_id: Option<String>,
    mine_x: bool,
    mine_o: bool,
    mine_upload: bool,
    side: Option<String>,
}

/// The quantile of `values` as DuckDB's quantile_cont computes it: linear between the two nearest ranks.
fn quantile(values: &mut [f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let position = q * (values.len() - 1) as f64;
    let (low, high) = (position.floor() as usize, position.ceil() as usize);
    Some(values[low] + (values[high] - values[low]) * (position - low as f64))
}

/// The rank of a value in a fixed order, unknown values last (list_position, which sorts NULL last).
fn rank(order: &[&str], value: Option<&str>) -> usize {
    value.and_then(|value| order.iter().position(|known| *known == value)).unwrap_or(usize::MAX)
}

/// Count rows by key, most first, then by key (SQL leaves the order of a tie open).
fn ranked_counts(counted: HashMap<String, i64>, limit: Option<usize>) -> Value {
    let mut rows: Vec<(String, i64)> = counted.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.into_iter().take(limit.unwrap_or(usize::MAX)).map(|(key, count)| json!({ "key": key, "count": count })).collect()
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

fn read_games(conn: &Connection, filter: &StatsFilter, tokens: &[String], now: i64) -> ApiResult<Vec<Game>> {
    let names = token_names(tokens);
    let since = since_of(filter, now);
    let mode = filter.mode.map(|mode| mode.as_str());
    let level = filter.level.map(|level| level.as_str());
    let mut params = token_params(&names, tokens);
    params.extend([("since", &since as &dyn ToSql), ("mode", &mode as &dyn ToSql), ("level", &level as &dyn ToSql)]);
    let filter_sql: FilterSql = bound_filter();
    let sql = format!(
        "SELECT epoch_ms(finished_at), mode, level, you, computer, tuned, hide_board, hide_history, hide_coordinates,
           to_json(moves)::VARCHAR, to_json(times)::VARCHAR, per_game, per_move, winner, ending, line, player_x, player_o,
           to_json(metrics)::VARCHAR, public_id, mine_x, mine_o, mine_upload, side
         FROM ({})",
        filtered_games(Some(tokens.len()), &filter_sql)
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let found = statement.query_map(params.as_slice(), |row| {
        // A list that does not parse is a fault, not an empty list: an empty list would hide the cause in the counts.
        fn list<T: serde::de::DeserializeOwned>(row: &duckdb::Row, index: usize) -> duckdb::Result<Vec<T>> {
            let text: Option<String> = row.get(index)?;
            let Some(text) = text else { return Ok(Vec::new()) };
            serde_json::from_str(&text)
                .map_err(|error| duckdb::Error::FromSqlConversionFailure(index, duckdb::types::Type::Text, Box::new(error)))
        }
        let metrics: Option<String> = row.get(18)?;
        Ok(Game {
            finished: row.get(0)?,
            mode: row.get(1)?,
            level: row.get(2)?,
            you: row.get(3)?,
            computer: row.get(4)?,
            tuned: row.get(5)?,
            hide_board: row.get(6)?,
            hide_history: row.get(7)?,
            hide_coordinates: row.get(8)?,
            moves: list(row, 9)?,
            times: list(row, 10)?,
            per_game: row.get(11)?,
            per_move: row.get(12)?,
            winner: row.get(13)?,
            ending: row.get(14)?,
            line: row.get(15)?,
            player_x: row.get(16)?,
            player_o: row.get(17)?,
            metrics: metrics.and_then(|text| serde_json::from_str::<Value>(&text).ok()).filter(|value| !value.is_null()),
            public_id: row.get(19)?,
            mine_x: row.get(20)?,
            mine_o: row.get(21)?,
            mine_upload: row.get(22)?,
            side: row.get(23)?,
        })
    })?;
    Ok(found.collect::<duckdb::Result<Vec<_>>>()?)
}

/// The person key of each token (PERSON in server/stats.ts): "github:<id>" for a linked token, else the token.
fn persons_of(conn: &Connection, tokens: &HashSet<&str>) -> ApiResult<HashMap<String, String>> {
    let asked: Vec<String> = tokens.iter().map(|token| (*token).to_owned()).collect();
    let linked: HashMap<String, i64> = conn
        .prepare_cached("FROM player_tokens SELECT token, github_id WHERE list_contains(CAST($tokens AS JSON)::VARCHAR[], token)")?
        .query_map([("tokens", &json_list(&asked) as &dyn ToSql)].as_slice(), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<duckdb::Result<_>>()?;
    Ok(asked
        .into_iter()
        .map(|token| (linked.get(&token).map_or_else(|| token.clone(), |id| format!("github:{id}")), token))
        .map(|(person, token)| (token, person))
        .collect())
}

/// The answer of a Mine or person filter, without `practice`, `person` and `achievements` (as compute_stats).
pub(super) fn personal_stats(conn: &Connection, now: i64, filter: &StatsFilter, tokens: &[String], sessions: usize) -> ApiResult<Value> {
    let games = read_games(conn, filter, tokens, now)?;
    let seat_tokens: HashSet<&str> = games.iter().flat_map(|game| [game.player_x.as_deref(), game.player_o.as_deref()]).flatten().collect();
    let persons = persons_of(conn, &seat_tokens)?;
    let person = |token: &str| persons.get(token).cloned().unwrap_or_else(|| token.to_owned());

    // Totals and days.
    let accounts: i64 = conn.prepare_cached("SELECT count(*) FROM users")?.query_row([], |row| row.get(0))?;
    let players: HashSet<String> =
        games.iter().flat_map(|game| [&game.player_x, &game.player_o]).flatten().map(|token| person(token)).collect();
    let week = now - 7 * DAY_MS;
    let days = filter.range.days().unwrap_or(60);
    let today = now.div_euclid(DAY_MS);
    let first = today - days + 1;
    let mut per_day: BTreeMap<i64, (i64, HashSet<String>)> = (first..=today).map(|day| (day, (0, HashSet::new()))).collect();
    for game in games.iter().filter(|game| game.finished >= first * DAY_MS) {
        if let Some((count, people)) = per_day.get_mut(&game.finished.div_euclid(DAY_MS)) {
            *count += 1;
            people.extend([&game.player_x, &game.player_o].into_iter().flatten().map(|token| person(token)));
        }
    }
    let per_day: Vec<Value> = per_day
        .into_iter()
        .map(|(day, (count, people))| {
            let date = chrono::DateTime::from_timestamp_millis(day * DAY_MS).expect("a stats day is a valid time").date_naive();
            json!({ "day": date.to_string(), "games": count, "players": people.len() })
        })
        .collect();
    let mut hours: BTreeMap<(i64, i64), i64> = BTreeMap::new();
    for game in &games {
        *hours
            .entry(((game.finished.div_euclid(DAY_MS) + 3).rem_euclid(7), game.finished.div_euclid(3_600_000).rem_euclid(24)))
            .or_default() += 1;
    }

    // Counts by mode, level, length, first move and cell.
    let by_mode_order = |mode: &str| rank(&SESSION_MODES, Some(mode));
    let mut by_mode: BTreeMap<usize, (String, i64)> = BTreeMap::new();
    let mut lengths_by_mode: BTreeMap<usize, (String, Vec<f64>)> = BTreeMap::new();
    let mut first_player: BTreeMap<usize, (String, [i64; 3])> = BTreeMap::new();
    let mut levels: BTreeMap<usize, (String, Vec<f64>, [i64; 4])> = BTreeMap::new();
    let mut openings: HashMap<i64, (i64, i64)> = HashMap::new();
    let mut lengths = vec![0i64; CELL_COUNT + 1];
    let mut cells: HashMap<i64, i64> = HashMap::new();
    let mut endings: HashMap<String, i64> = HashMap::new();
    let mut hide: BTreeMap<(usize, bool), [i64; 3]> = BTreeMap::new();
    let mut time_limits: HashMap<TimeLimit, i64> = HashMap::new();
    let mut tuned: BTreeMap<bool, [i64; 2]> = BTreeMap::new();
    for game in &games {
        let moves = game.moves.len();
        by_mode.entry(by_mode_order(&game.mode)).or_insert((game.mode.clone(), 0)).1 += 1;
        lengths_by_mode.entry(by_mode_order(&game.mode)).or_insert((game.mode.clone(), Vec::new())).1.push(moves as f64);
        let winner = game.winner.as_deref();
        let first = &mut first_player.entry(by_mode_order(&game.mode)).or_insert((game.mode.clone(), [0; 3])).1;
        match winner {
            Some("X") => first[0] += 1,
            Some("O") => first[1] += 1,
            None => first[2] += 1,
            _ => {}
        }
        let human_won = winner.is_some() && winner == game.you.as_deref();
        if game.mode == "computer" {
            let level = game.level.clone().ok_or_else(|| ApiError::fault("a computer game has no level"))?;
            let entry = levels.entry(rank(&DIFFICULTIES, Some(&level))).or_insert((level, Vec::new(), [0; 4]));
            entry.1.push(moves as f64);
            entry.2[0] += i64::from(human_won);
            entry.2[1] += i64::from(winner.is_none());
            entry.2[2] += i64::from(winner.is_some() && winner == game.computer.as_deref());
            entry.2[3] += i64::from(game.tuned);
            tuned.entry(game.tuned).or_default()[0] += 1;
            tuned.entry(game.tuned).or_default()[1] += i64::from(human_won);
        }
        if let Some(&cell) = game.moves.first() {
            let entry = openings.entry(cell).or_default();
            entry.0 += 1;
            entry.1 += i64::from(winner == Some("X"));
        }
        *lengths.get_mut(moves).ok_or_else(|| ApiError::fault(format!("a stored game has {moves} moves")))? += 1;
        for &cell in &game.moves {
            *cells.entry(cell).or_default() += 1;
        }
        *endings.entry(game.line.clone().unwrap_or_else(|| game.ending.clone())).or_default() += 1;
        let setting = match (game.hide_board, game.hide_history) {
            (true, true) => "both",
            (true, false) => "board",
            (false, true) => "history",
            (false, false) => "none",
        };
        let row = hide.entry((rank(&HIDE_SETTINGS, Some(setting)), game.hide_coordinates)).or_default();
        row[0] += 1;
        row[1] += i64::from(game.mode == "computer");
        row[2] += i64::from(game.mode == "computer" && human_won);
        *time_limits.entry((game.per_game, game.per_move)).or_default() += 1;
    }

    // The time between two moves, by the player who moved (X makes the odd moves, 1-based).
    let mut buckets = [[0i64; 2]; MOVE_TIME_BUCKETS as usize];
    let mut timed: BTreeMap<usize, (String, Vec<f64>, Vec<f64>)> = BTreeMap::new();
    let key_order: Vec<&str> = DIFFICULTIES.iter().chain(SESSION_MODES.iter()).copied().collect();
    let mut search: HashMap<String, Vec<f64>> = HashMap::new();
    for game in &games {
        let key = game.level.clone().unwrap_or_else(|| game.mode.clone());
        for i in 2..=game.times.len() {
            let ms = game.times[i - 1] - game.times[i - 2];
            if ms <= 0.0 {
                continue;
            }
            let mover = if i % 2 == 1 { "X" } else { "O" };
            let computer = game.computer.as_deref() == Some(mover);
            let bucket =
                [1000.0, 2000.0, 5000.0, 10_000.0, 30_000.0, 60_000.0, 300_000.0].iter().position(|limit| ms < *limit).unwrap_or(7);
            buckets[bucket][usize::from(computer)] += 1;
            let entry = timed.entry(rank(&key_order, Some(&key))).or_insert((key.clone(), Vec::new(), Vec::new()));
            if computer { entry.2.push(ms) } else { entry.1.push(ms) }
        }
        if game.mode == "computer"
            && let Some(level) = &game.level
        {
            let think = game.metrics.as_ref().and_then(|metrics| metrics["thinkMs"].as_array().cloned()).unwrap_or_default();
            search.entry(level.clone()).or_default().extend(think.iter().filter_map(Value::as_f64));
        }
    }

    // Metrics: the reports of the player's own uploads, and of the player's seats of online games.
    let mut reports: Vec<Value> = games.iter().filter(|game| game.mine_upload).filter_map(|game| game.metrics.clone()).collect();
    let mine_seats: HashMap<&str, (bool, bool)> =
        games.iter().filter_map(|game| game.public_id.as_deref().map(|id| (id, (game.mine_x, game.mine_o)))).collect();
    if !mine_seats.is_empty() {
        let ids: Vec<String> = mine_seats.keys().map(|id| (*id).to_owned()).collect();
        let sql = format!(
            "SELECT sm.public_id, sm.seat, to_json({})::VARCHAR FROM seat_metrics sm WHERE list_contains(CAST($ids AS JSON)::VARCHAR[], sm.public_id)",
            FROM_NODE.fields.metrics_of_seat_metrics
        );
        let seat_rows = conn
            .prepare_cached(&sql)?
            .query_map([("ids", &json_list(&ids) as &dyn ToSql)].as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        for (id, seat, metrics) in seat_rows {
            let (mine_x, mine_o) = mine_seats[id.as_str()];
            if (seat == "X" && mine_x) || (seat == "O" && mine_o) {
                // A game can appear twice when one player held both seats; the SQL join counts each pair once per game row.
                if let Some(metrics) = metrics.and_then(|text| serde_json::from_str::<Value>(&text).ok()).filter(|value| !value.is_null()) {
                    reports.push(metrics);
                }
            }
        }
    }
    let field_counts = |field: &str| {
        let mut counted: HashMap<String, i64> = HashMap::new();
        for report in &reports {
            *counted.entry(text_of(&report[field]).unwrap_or_else(|| "unknown".into())).or_default() += 1;
        }
        ranked_counts(counted, Some(12))
    };
    let sum = |pick: &dyn Fn(&Value) -> &Value| reports.iter().filter_map(|report| pick(report).as_i64()).sum::<i64>();
    let refusals = metric_lists().refusals();
    let refused: Vec<Value> = refusals
        .iter()
        .map(|reason| (reason, reports.iter().filter_map(|report| report["refused"][reason.as_str()].as_i64()).sum::<i64>()))
        .filter(|(_, count)| *count > 0)
        .map(|(reason, count)| json!({ "key": reason, "count": count }))
        .collect();
    let mut versions: HashMap<String, i64> = HashMap::new();
    for report in &reports {
        *versions.entry(report["version"].as_str().unwrap_or("unknown").to_owned()).or_default() += 1;
    }
    let releases = release_rows(conn, versions)?;
    let mut mixes: HashMap<String, i64> = HashMap::new();
    for game in games.iter().filter(|game| game.mode == "nearby") {
        let Some(metrics) = &game.metrics else { continue };
        if metrics["nearby"]["role"].as_str() != Some("host") {
            continue;
        }
        let mut pair =
            [text_of(&metrics["device"]).unwrap_or_default(), text_of(&metrics["nearby"]["other"]).unwrap_or_else(|| "unknown".into())];
        pair.sort();
        *mixes.entry(pair.join(" + ")).or_default() += 1;
    }

    // Outcomes from the player's side, oldest first.
    let mut sided: Vec<(i64, SideOutcome)> = games
        .iter()
        .filter_map(|game| {
            let side = game.side.as_deref()?;
            let outcome = match game.winner.as_deref() {
                None => SideOutcome::Drawn,
                Some(winner) if winner == side => SideOutcome::Won,
                Some(_) => SideOutcome::Lost,
            };
            Some((game.finished, outcome))
        })
        .collect();
    sided.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    sided.truncate(SIDED_GAMES as usize);
    sided.reverse();

    let personal = personal_part(conn, &games, &sided, filter.scope == StatsScope::Mine, &person)?;
    let mut time_rows: Vec<(TimeLimit, i64)> = time_limits.into_iter().collect();
    time_rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let think_times: Vec<Value> = timed
        .into_values()
        .map(|(key, mut human, mut computer)| {
            let mut searched = search.get(&key).cloned().unwrap_or_default();
            json!({
                "key": key, "humanMs": js_option(quantile(&mut human, 0.5)), "computerMs": js_option(quantile(&mut computer, 0.5)),
                "searchMs": js_option(quantile(&mut searched, 0.5)),
            })
        })
        .collect();
    let openings_list: Vec<(i64, i64, i64)> = openings.iter().map(|(cell, (count, wins))| (*cell, *count, *wins)).collect();
    Ok(json!({
        "generatedAt": now,
        "totals": {
            "games": games.len(), "moves": games.iter().map(|game| game.moves.len()).sum::<usize>(), "players": players.len(), "accounts": accounts,
            "sessions": sessions, "gamesLast7Days": games.iter().filter(|game| game.finished >= week).count(),
        },
        "perDay": per_day,
        "hours": hours.into_iter().map(|((day, hour), count)| json!({ "day": day, "hour": hour, "games": count })).collect::<Vec<_>>(),
        "byMode": by_mode.into_values().map(|(key, count)| json!({ "key": key, "count": count })).collect::<Vec<_>>(),
        "levels": levels.into_values().map(|(level, mut lengths, [won, drawn, lost, tuned])| {
            let games = lengths.len();
            let avg = lengths.iter().sum::<f64>() / games as f64;
            json!({ "level": level, "games": games, "won": won, "drawn": drawn, "lost": lost, "avgMoves": js_number(avg),
                "medianMoves": js_number(quantile(&mut lengths, 0.5).expect("a level row has games")), "tuned": tuned })
        }).collect::<Vec<_>>(),
        "lengthByMode": lengths_by_mode.into_values().map(|(mode, mut lengths)| {
            let games = lengths.len();
            let avg = lengths.iter().sum::<f64>() / games as f64;
            let median = quantile(&mut lengths, 0.5).expect("a mode row has games");
            json!({ "mode": mode, "games": games, "avg": js_number(avg), "median": js_number(median), "p90": js_number(quantile(&mut lengths, 0.9).expect("games")) })
        }).collect::<Vec<_>>(),
        "moveTimes": buckets.iter().enumerate().map(|(bucket, [human, computer])| json!({ "bucket": bucket, "human": human, "computer": computer })).collect::<Vec<_>>(),
        "thinkTimes": think_times,
        "firstPlayer": first_player.into_values().map(|(mode, [x, o, draws])| json!({ "mode": mode, "x": x, "o": o, "draws": draws })).collect::<Vec<_>>(),
        "openings": per_cell(openings_list.iter().map(|row| (row.0, row.1)))?,
        "openingWinsX": per_cell(openings_list.iter().map(|row| (row.0, row.2)))?,
        "cells": per_cell(cells)?,
        "endings": ranked_counts(endings, None),
        "hide": hide.into_iter().map(|((setting, coordinates), [games, computer, wins])| json!({
            "setting": HIDE_SETTINGS[setting], "coordinates": coordinates, "games": games, "computerGames": computer, "humanWins": wins,
        })).collect::<Vec<_>>(),
        "timeLimits": time_rows.into_iter().take(8).map(|((per_game, per_move), games)| json!({ "perGame": per_game, "perMove": per_move, "games": games })).collect::<Vec<_>>(),
        "tuned": tuned.into_iter().map(|(tuned, [games, wins])| json!({ "tuned": tuned, "games": games, "humanWins": wins })).collect::<Vec<_>>(),
        "sample": Value::Null,
        "metricsGames": reports.len(),
        "devices": field_counts("device"),
        "views": field_counts("view"),
        "layouts": field_counts("layout"),
        "themes": field_counts("theme"),
        "releases": releases,
        "input": { "board": sum(&|report| &report["input"]["board"]), "keypad": sum(&|report| &report["input"]["keypad"]) },
        "refusals": refused,
        "undo": { "gamesWithUndo": reports.iter().filter(|report| report["undos"].as_i64().unwrap_or(0) > 0).count(), "undos": sum(&|report| &report["undos"]) },
        "offlineGames": reports.iter().filter(|report| report["offline"].as_bool() == Some(true)).count(),
        "nearbyMixes": ranked_counts(mixes, None),
        "filter": filter,
        "form": form_of(&sided),
        "lengths": lengths,
        "personal": personal,
    }))
}

/// The releases of the reported page versions: newest release first, unknown versions last, at most RELEASE_ROWS.
fn release_rows(conn: &Connection, versions: HashMap<String, i64>) -> ApiResult<Vec<Value>> {
    if versions.is_empty() {
        return Ok(Vec::new());
    }
    let asked: Vec<String> = versions.keys().cloned().collect();
    let known: HashMap<String, (Option<String>, Option<i64>)> = conn
        .prepare_cached(
            "FROM releases SELECT version, name, epoch_ms(released_at) WHERE list_contains(CAST($versions AS JSON)::VARCHAR[], version)",
        )?
        .query_map([("versions", &json_list(&asked) as &dyn ToSql)].as_slice(), |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect::<duckdb::Result<_>>()?;
    let mut rows: Vec<(String, Option<String>, Option<i64>, i64)> = versions
        .into_iter()
        .map(|(version, count)| {
            let (name, at) = known.get(&version).cloned().unwrap_or((None, None));
            (version, name, at, count)
        })
        .collect();
    rows.sort_by(|a, b| b.2.is_some().cmp(&a.2.is_some()).then(b.2.cmp(&a.2)).then(b.3.cmp(&a.3)).then_with(|| a.0.cmp(&b.0)));
    Ok(rows
        .into_iter()
        .take(RELEASE_ROWS as usize)
        .map(|(version, name, at, count)| json!({ "version": version, "name": name, "at": at, "count": count }))
        .collect())
}

/// The results of the player from the side that they played, their survival records, streaks and opponents.
fn personal_part(
    conn: &Connection,
    games: &[Game],
    sided: &[(i64, SideOutcome)],
    with_opponents: bool,
    person: &dyn Fn(&str) -> String,
) -> ApiResult<Value> {
    let mut results: BTreeMap<(usize, usize), ResultRow> = BTreeMap::new();
    let mut survival: BTreeMap<usize, (String, usize)> = BTreeMap::new();
    let mut opponents: HashMap<String, (String, [i64; 4])> = HashMap::new();
    for game in games {
        let Some(side) = game.side.as_deref() else { continue };
        let entry = results.entry((rank(&SESSION_MODES, Some(&game.mode)), rank(&DIFFICULTIES, game.level.as_deref()))).or_insert((
            game.mode.clone(),
            game.level.clone(),
            [0; 3],
        ));
        match game.winner.as_deref() {
            Some(winner) if winner == side => entry.2[0] += 1,
            None => entry.2[1] += 1,
            Some(_) => entry.2[2] += 1,
        }
        if game.mode == "computer" && !game.tuned && game.winner.is_some() && game.winner == game.computer {
            let level = game.level.clone().ok_or_else(|| ApiError::fault("a computer game has no level"))?;
            let entry = survival.entry(rank(&DIFFICULTIES, Some(&level))).or_insert((level, 0));
            entry.1 = entry.1.max(game.moves.len());
        }
        if with_opponents && game.mode != "computer" {
            let other = if side == "X" { &game.player_o } else { &game.player_x };
            if let Some(token) = other {
                let entry = opponents.entry(person(token)).or_insert((token.clone(), [0; 4]));
                entry.1[0] += 1;
                match game.winner.as_deref() {
                    Some(winner) if winner == side => entry.1[1] += 1,
                    None => entry.1[2] += 1,
                    Some(_) => entry.1[3] += 1,
                }
            }
        }
    }
    let opponents = if opponents.is_empty() { Vec::new() } else { opponent_rows(conn, opponents)? };
    let outcomes: Vec<SideOutcome> = sided.iter().map(|(_, outcome)| *outcome).collect();
    let (best, current) = streaks_of(&outcomes);
    Ok(json!({
        "survival": survival.into_values().map(|(level, moves)| json!({ "level": level, "moves": moves })).collect::<Vec<_>>(),
        "results": results.into_values().map(|(mode, level, [won, drawn, lost])| json!({ "mode": mode, "level": level, "won": won, "drawn": drawn, "lost": lost })).collect::<Vec<_>>(),
        "bestStreak": best,
        "currentStreak": current,
        "opponents": opponents,
    }))
}

/// The 5 opponents with the most games, with their names. `opponents` maps a person to one of its tokens and the counts.
fn opponent_rows(conn: &Connection, opponents: HashMap<String, (String, [i64; 4])>) -> ApiResult<Vec<Value>> {
    let tokens: Vec<String> = opponents.values().map(|(token, _)| token.clone()).collect();
    let names: HashMap<String, (Option<String>, Option<String>)> = conn
        .prepare_cached(
            "SELECT t.token, coalesce(u.name, u.login), pn.name
             FROM (SELECT unnest(CAST($tokens AS JSON)::VARCHAR[]) AS token) t
               LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id LEFT JOIN player_names pn USING (token)",
        )?
        .query_map([("tokens", &json_list(&tokens) as &dyn ToSql)].as_slice(), |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect::<duckdb::Result<_>>()?;
    let mut rows: Vec<OpponentRow> = opponents
        .into_iter()
        .map(|(person, (token, counts))| {
            let (account, custom) = names.get(&token).cloned().unwrap_or((None, None));
            (person, account, custom, counts)
        })
        .collect();
    rows.sort_by(|a, b| b.3[0].cmp(&a.3[0]).then(a.1.is_none().cmp(&b.1.is_none())).then(a.1.cmp(&b.1)).then(a.0.cmp(&b.0)));
    Ok(rows
        .into_iter()
        .take(5)
        .map(|(person, account, custom, [games, won, drawn, lost])| {
            json!({ "player": person_name(account, custom, &person), "games": games, "won": won, "drawn": drawn, "lost": lost })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};

    use super::super::stats::compute_stats;
    use super::super::{Hooks, Store};
    use crate::protocol::{Difficulty, GameMode, Release, StatsFilter, StatsRange, StatsScope};

    struct NoPages;
    impl Hooks for NoPages {
        fn open_tokens(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn changed(&self, _: &str) {}
    }

    const ALICE: &str = "00000000000000a1-alice";
    const GUEST: &str = "00000000000000b2-guest";
    const DAY: i64 = 86_400_000;

    /// A full cube without a line, X and O in turn (the draw of src/achievements.test.ts).
    fn draw() -> Vec<i64> {
        let board = "XXOXOOXOXOXXXXOXOOXOOXOXXOXXXOOXOOXOXXXOXOOXOXOOOOXXOXOOOXXOXOXO";
        let cells = |mark: char| board.char_indices().filter(|(_, value)| *value == mark).map(|(cell, _)| cell as i64).collect::<Vec<_>>();
        cells('X').into_iter().zip(cells('O')).flat_map(|(x, o)| [x, o]).collect()
    }

    /// Varied games of Alice: every mode but online, every level, both seats, tuned, hidden options, time limits, draws,
    /// a timeout, Nearby with a guest, and metrics with refusals, undos, offline play and two page versions.
    fn uploads(now: i64) -> Vec<Value> {
        let lines: [Vec<i64>; 3] = [vec![0, 16, 1, 17, 2, 18, 3], vec![4, 0, 5, 1, 6, 2, 32, 3], vec![0, 1, 21, 2, 42, 3, 63]];
        let modes = ["computer", "computer", "computer", "friend", "nearby"];
        (0..60)
            .map(|n: i64| {
                let mode = modes[(n % 5) as usize];
                let mut moves = if n % 13 == 0 { draw() } else { lines[(n % 3) as usize].clone() };
                let timed_out = n % 11 == 0;
                if timed_out {
                    moves.truncate(4);
                }
                let finished = now - (n * 17 % 45) * DAY - n * 61_000;
                let times: Vec<i64> = (0..moves.len()).map(|i| finished - (moves.len() - i) as i64 * (300 + (n * 977 + i as i64 * 431) % 9000)).collect();
                let you = if mode == "friend" { Value::Null } else { json!(if n % 2 == 0 { "X" } else { "O" }) };
                let device = ["phone", "tablet", "computer"][(n % 3) as usize];
                let level = ["easy", "medium", "hard"][(n % 3) as usize];
                let metrics = (n % 4 != 3).then(|| {
                    json!({ "device": device, "view": "tower", "layout": "grid", "theme": if n % 2 == 0 { "dark" } else { "light" },
                        "input": { "board": n % 5, "keypad": n % 3, "voice": 0 }, "refused": if n % 6 == 0 { json!({ "occupied": 2 }) } else { json!({}) },
                        "undos": n % 3, "thinkMs": [10.5 + n as f64, 30.0], "offline": n % 7 == 0, "version": if n % 2 == 0 { "main-aaaa1" } else { "main-bbbb2" },
                        "tuning": null, "nearby": if mode == "nearby" { json!({ "role": "host", "other": "phone" }) } else { Value::Null } })
                });
                json!({
                    "id": format!("personal-test-{n:06}-0000"), "mode": mode,
                    "game": { "moves": moves, "times": times, "clock": { "perMove": if n % 4 == 0 { json!(10) } else { Value::Null }, "perGame": if n % 5 == 1 { json!(120) } else { Value::Null } }, "timedOut": timed_out },
                    "you": you, "difficulty": if mode == "computer" { json!(level) } else { Value::Null },
                    "finishedAt": finished, "options": { "hideBoard": n % 3 == 0, "hideHistory": n % 4 == 0, "hideCoordinates": n % 5 == 0 },
                    "tuned": mode == "computer" && n % 9 == 0, "metrics": metrics,
                    "guest": if mode == "nearby" && n % 2 == 0 { json!(GUEST) } else { Value::Null },
                })
            })
            .collect()
    }

    /// Sorts the lists whose order SQL leaves open on a tie, so the two answers compare.
    fn canonical(mut answer: Value) -> Value {
        for key in ["endings", "devices", "views", "layouts", "themes", "nearbyMixes", "timeLimits", "hours"] {
            if let Some(list) = answer[key].as_array_mut() {
                list.sort_by_key(|item| item.to_string());
            }
        }
        answer
    }

    #[tokio::test]
    async fn counts_the_same_as_the_sql_stats() {
        let dir = std::env::temp_dir().join(format!("tick3d-personal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(path.to_str().unwrap(), Arc::new(NoPages)).unwrap();
        let now = super::super::now_ms();
        store
            .call(move |db| {
                db.add_results(ALICE, &uploads(now))?;
                db.add_release(&Release { version: "main-aaaa1".into(), name: "First".into(), at: now - 50 * DAY })?;
                Ok(())
            })
            .await
            .unwrap();
        // The result batch writes a moment later.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let filters = [
            (StatsRange::All, None, None),
            (StatsRange::Week, None, None),
            (StatsRange::Month, Some(GameMode::Computer), None),
            (StatsRange::All, Some(GameMode::Computer), Some(Difficulty::Hard)),
            (StatsRange::All, Some(GameMode::Nearby), None),
        ];
        for (range, mode, level) in filters {
            // Mine names the opponents; a person filter does not.
            let person = Some("0123456789abcdef".to_owned());
            for (scope, person, tokens) in [
                (StatsScope::Mine, None, vec![ALICE.to_owned()]),
                (StatsScope::Mine, None, vec![GUEST.to_owned()]),
                (StatsScope::Everyone, person, vec![ALICE.to_owned()]),
            ] {
                let filter = StatsFilter { scope, range, mode, level, person };
                let (sql, rust) = store
                    .read(move |conn| {
                        let sql = compute_stats(conn, now, &filter, Some(&tokens), 3)?;
                        let mut rust = super::personal_stats(conn, now, &filter, &tokens, 3)?;
                        rust["practice"] = sql["practice"].clone();
                        Ok((sql, rust))
                    })
                    .await
                    .unwrap();
                let (sql, rust) = (canonical(sql), canonical(rust));
                if sql != rust {
                    for key in sql.as_object().unwrap().keys() {
                        assert_eq!(rust[key], sql[key], "{key} differs for {range:?} {mode:?} {level:?}");
                    }
                }
                assert_eq!(rust, sql);
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

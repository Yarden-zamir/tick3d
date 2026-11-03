//! The practice room: its runs and leaderboards (server/store.ts addPracticeRun, practiceBoard; server/practice.ts).
use serde::Serialize;
use tick3d_core::names::name_of;
use tick3d_core::playoff::PresetId;

use duckdb::Connection;

use super::{Db, json_list};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{PracticeMode, PracticeRun};

/// The person of a token: the GitHub account, else the token (PERSON in server/stats.ts).
pub(super) const PERSON: &str = "coalesce('github:' || pt.github_id, token)";
/// The name of an account: the custom name, else the login (ACCOUNT_NAME in server/stats.ts).
pub(super) const ACCOUNT_NAME: &str = "coalesce(u.name, u.login)";

/// The shown name of a person: the account name, else the custom name of the device, else the generated name
/// (personName in server/stats.ts). The person text stays on the server.
pub(super) fn person_name(account: Option<String>, custom: Option<String>, person: &str) -> String {
    account.or(custom).unwrap_or_else(|| name_of(person))
}

/// One row per run, with the person, its names, and a sort key: a target run by its total time, an echo run by its
/// points (more first), then its time. The best run of a person has the smallest key.
fn runs_sql() -> String {
    format!(
        "WITH runs AS (
           FROM practice_runs LEFT JOIN player_tokens pt USING (token) LEFT JOIN users u ON u.github_id = pt.github_id
             LEFT JOIN player_names pn USING (token)
           SELECT mode, preset, {PERSON} AS person, {ACCOUNT_NAME} AS account, pn.name AS custom, total_ms, score, round_ms,
             CASE WHEN mode = 'echo' THEN (1000 - score)::BIGINT * 1000000000 + total_ms ELSE total_ms::BIGINT END AS key
         ), best AS (
           SELECT mode, preset, person, any_value(account) AS account, any_value(custom) AS custom, min(key) AS key,
             arg_min(total_ms, key) AS total_ms, arg_min(score, key) AS score
           FROM runs GROUP BY mode, preset, person
         )"
    )
}

/// One place of a leaderboard. `player` is a name, never a token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeLeader {
    mode: PracticeMode,
    preset: PresetId,
    rank: i32,
    player: String,
    total_ms: i32,
    score: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnBest {
    total_ms: i32,
    score: i32,
}

/// GET /api/practice/best: the best 10 people of one mode and preset, and the best of the caller.
#[derive(Serialize)]
pub struct PracticeBoard {
    mode: PracticeMode,
    preset: PresetId,
    top: Vec<PracticeLeader>,
    you: Option<OwnBest>,
}

impl Db {
    /// Stores a finished run. A run with an id that this player sent before changes nothing.
    pub fn add_practice_run(&mut self, token: &str, run: PracticeRun) -> ApiResult<bool> {
        let total: i64 = run.round_ms.iter().map(|ms| i64::from(*ms)).sum();
        let rounds = serde_json::to_string(&run.round_ms).expect("numbers serialize");
        let inserted = self.query(
            "INSERT INTO practice_runs (token, id, mode, preset, total_ms, round_ms, score, finished_at)
             VALUES ($token, $id, $mode, $preset, $total, CAST($rounds AS JSON)::INTEGER[], $score, make_timestamptz($now * 1000))
             ON CONFLICT DO NOTHING RETURNING id",
            &[
                ("token", &token),
                ("id", &run.id),
                ("mode", &run.mode.as_str()),
                ("preset", &run.preset.as_str()),
                ("total", &total),
                ("rounds", &rounds),
                ("score", &run.score),
                ("now", &super::now_ms()),
            ],
            |row| row.get::<_, String>(0),
        )?;
        Ok(!inserted.is_empty())
    }

    /// The leaderboard of one mode and preset, and the best run of the caller on all linked devices.
    pub fn practice_board(&mut self, mode: PracticeMode, preset: PresetId, token: Option<&str>) -> ApiResult<PracticeBoard> {
        let top = practice_leaders(&self.conn, 10, Some((mode, preset)))?;
        let tokens: Vec<String> = self.identity_of(token)?.into_iter().collect();
        if tokens.is_empty() {
            return Ok(PracticeBoard { mode, preset, top, you: None });
        }
        let you = self
            .query(
                "FROM practice_runs SELECT total_ms, score
                 WHERE mode = $mode AND preset = $preset AND list_contains(CAST($tokens AS JSON)::VARCHAR[], token)
                 ORDER BY CASE WHEN mode = 'echo' THEN -score ELSE 0 END, total_ms LIMIT 1",
                &[("mode", &mode.as_str()), ("preset", &preset.as_str()), ("tokens", &json_list(&tokens))],
                |row| Ok(OwnBest { total_ms: row.get(0)?, score: row.get(1)? }),
            )?
            .into_iter()
            .next();
        Ok(PracticeBoard { mode, preset, top, you })
    }
}

/// The best `limit` people of each mode and preset (leaders in server/practice.ts). `only` limits the list to one mode
/// and preset. A free function, so the reader connection runs it for the Everyone stats too.
fn practice_leaders(conn: &Connection, limit: i64, only: Option<(PracticeMode, PresetId)>) -> ApiResult<Vec<PracticeLeader>> {
    let sql = format!(
        "{} SELECT mode, preset, row_number() OVER (PARTITION BY mode, preset ORDER BY key, account NULLS LAST, person)::INTEGER AS rank,
           account, custom, person, total_ms, score
         FROM best {} QUALIFY rank <= $limit ORDER BY mode, preset, rank",
        runs_sql(),
        if only.is_some() { "WHERE mode = $mode AND preset = $preset" } else { "" }
    );
    let (mode, preset) = only.map_or(("", ""), |(mode, preset)| (mode.as_str(), preset.as_str()));
    let params: Vec<(&str, &dyn duckdb::ToSql)> =
        if only.is_some() { vec![("limit", &limit), ("mode", &mode), ("preset", &preset)] } else { vec![("limit", &limit)] };
    let found = conn
        .prepare(&sql)?
        .query_map(params.as_slice(), |row| {
            let texts: [String; 2] = [row.get(0)?, row.get(1)?];
            let person: String = row.get(5)?;
            Ok((texts, row.get::<_, i32>(2)?, person_name(row.get(3)?, row.get(4)?, &person), row.get::<_, i32>(6)?, row.get::<_, i32>(7)?))
        })?
        .collect::<duckdb::Result<Vec<_>>>()?;
    found
        .into_iter()
        .map(|([mode, preset], rank, player, total_ms, score)| {
            let mode = PracticeMode::parse(&mode).ok_or_else(|| ApiError::fault(format!("a practice run has the unknown mode {mode}")))?;
            let preset =
                PresetId::parse(&preset).ok_or_else(|| ApiError::fault(format!("a practice run has the unknown preset {preset}")))?;
            Ok(PracticeLeader { mode, preset, rank, player, total_ms, score })
        })
        .collect()
}

/// The runs of one mode and preset on the stats page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeRuns {
    mode: PracticeMode,
    preset: PresetId,
    runs: i32,
    players: i32,
    avg_round_ms: Option<f64>,
}

/// The practice part of the stats page (PracticeStats in src/protocol.ts).
#[derive(Serialize)]
pub struct PracticeStats {
    runs: Vec<PracticeRuns>,
    best: Vec<PracticeLeader>,
}

/// practiceStats in server/practice.ts.
pub(super) fn practice_stats(conn: &Connection) -> ApiResult<PracticeStats> {
    let sql = format!(
        "{} SELECT mode, preset, count(*)::INTEGER AS runs, count(DISTINCT person)::INTEGER AS players,
           (SELECT avg(t) FROM (SELECT unnest(r.round_ms) AS t FROM runs r WHERE r.mode = runs.mode AND r.preset = runs.preset)) AS avg_round_ms
         FROM runs GROUP BY mode, preset ORDER BY mode, preset",
        runs_sql()
    );
    let found = conn
        .prepare(&sql)?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
        .collect::<duckdb::Result<Vec<_>>>()?;
    let runs = found
        .into_iter()
        .map(|(mode, preset, runs, players, avg_round_ms)| {
            Ok(PracticeRuns {
                mode: PracticeMode::parse(&mode).ok_or_else(|| ApiError::fault(format!("a practice run has the unknown mode {mode}")))?,
                preset: PresetId::parse(&preset)
                    .ok_or_else(|| ApiError::fault(format!("a practice run has the unknown preset {preset}")))?,
                runs,
                players,
                avg_round_ms,
            })
        })
        .collect::<ApiResult<_>>()?;
    Ok(PracticeStats { runs, best: practice_leaders(conn, 5, None)? })
}

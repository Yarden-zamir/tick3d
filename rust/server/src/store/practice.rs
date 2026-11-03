//! The practice room: its runs and leaderboards (server/store.ts addPracticeRun, practiceBoard; server/practice.ts).
use serde::Serialize;
use tick3d_core::names::name_of;
use tick3d_core::playoff::PresetId;

use super::{Db, json_list};
use crate::error::ApiResult;
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

    /// The best `limit` people of one mode and preset.
    /// Limit: the stats page also reads the best of every mode and preset (practiceStats). Add that with the stats.
    fn practice_leaders(&self, limit: i64, mode: PracticeMode, preset: PresetId) -> ApiResult<Vec<PracticeLeader>> {
        let sql = format!(
            "{} SELECT row_number() OVER (PARTITION BY mode, preset ORDER BY key, account NULLS LAST, person)::INTEGER AS rank,
               account, custom, person, total_ms, score
             FROM best WHERE mode = $mode AND preset = $preset
             QUALIFY rank <= $limit ORDER BY rank",
            runs_sql()
        );
        Ok(self.query(&sql, &[("mode", &mode.as_str()), ("preset", &preset.as_str()), ("limit", &limit)], |row| {
            let person: String = row.get(3)?;
            Ok(PracticeLeader {
                mode,
                preset,
                rank: row.get(0)?,
                player: person_name(row.get(1)?, row.get(2)?, &person),
                total_ms: row.get(4)?,
                score: row.get(5)?,
            })
        })?)
    }

    /// The leaderboard of one mode and preset, and the best run of the caller on all linked devices.
    pub fn practice_board(&mut self, mode: PracticeMode, preset: PresetId, token: Option<&str>) -> ApiResult<PracticeBoard> {
        let top = self.practice_leaders(10, mode, preset)?;
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

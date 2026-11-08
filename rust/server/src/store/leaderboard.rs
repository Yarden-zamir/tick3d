//! The leaderboard: the common stats of each person, from
//! their side of each game. The store adds the names and the person ids, so no token leaves the server.
use duckdb::{Connection, ToSql};
use serde::Serialize;
use serde_json::Value;
use tick3d_core::names::name_of;
use tick3d_core::session::{COMPUTER_TOKEN, PlayerInfo};

use super::accounts::{AccountRow, account_of, account_row};
use super::stats::{bound_filter, filtered_games, since_of};
use super::{Db, Store, now_ms};
use crate::error::ApiResult;
use crate::ids::{ACCOUNT_TOKEN_PREFIX, person_id};
use crate::protocol::StatsFilter;

/// LEADERBOARD_ROWS in src/protocol.ts: the most active players first, at most this many.
const LEADERBOARD_ROWS: i64 = 500;

/// One row per seat of a person in a game. A friend game holds both seats on one device, so it has no side. `owner` is the
/// canonical token. A person who hides their stats (private_stats) stays out. The unlocks come from achievement_players,
/// which the store brings up to date first.
/// Limit: revisit this when a call takes more than about 1 s.
fn leaderboard_sql() -> String {
    format!(
        "WITH g AS ({}),
           seats AS (
             SELECT finished_at, result_id, len(moves) AS moves, winner, ending, 'X' AS seat, player_x AS token FROM g WHERE player_x IS DISTINCT FROM player_o
             UNION ALL
             SELECT finished_at, result_id, len(moves) AS moves, winner, ending, 'O' AS seat, player_o AS token FROM g WHERE player_x IS DISTINCT FROM player_o
           ),
           played AS (
             -- A seat can hold the account token itself, which has no player_tokens row.
             SELECT coalesce($account || lpad(pt.github_id::VARCHAR, 16, '0'), token) AS owner,
               coalesce(pt.github_id, CASE WHEN starts_with(token, $account) THEN ltrim(substr(token, length($account) + 1), '0')::BIGINT END) AS github_id,
               finished_at, result_id, moves, ending,
               coalesce(winner = seat, false) AS won, winner IS NULL AS drawn
             FROM seats LEFT JOIN player_tokens pt USING (token)
             WHERE token IS NOT NULL AND token <> $computer
           ),
           shown AS (FROM played WHERE owner NOT IN (FROM private_stats SELECT owner)),
           -- A run counts the games since the last game that was not a win, so each run of wins has one number.
           -- result_id orders two games that end in the same millisecond, so the best streak is the same on every call.
           runs AS (SELECT owner, won, sum(CASE WHEN won THEN 0 ELSE 1 END) OVER (PARTITION BY owner ORDER BY finished_at, result_id ROWS UNBOUNDED PRECEDING) AS run FROM shown),
           streaks AS (SELECT owner, max(wins)::INTEGER AS best_streak FROM (SELECT owner, run, count(*) FILTER (won) AS wins FROM runs GROUP BY owner, run) GROUP BY owner),
           totals AS (
             SELECT owner, any_value(github_id) AS github_id, count(*)::INTEGER AS games, count(*) FILTER (won)::INTEGER AS won,
               count(*) FILTER (drawn)::INTEGER AS drawn, count(*) FILTER (NOT won AND NOT drawn)::INTEGER AS lost,
               -- A win on time can come after any number of moves, so only a won line counts as a fast win.
               min(moves) FILTER (won AND ending = 'won')::INTEGER AS fastest_win, avg(moves) AS avg_moves, epoch_ms(max(finished_at)) AS last_played
             FROM shown GROUP BY owner
           )
         SELECT owner, u.provider, u.login, u.avatar, u.name, u.seed, games, won, drawn, lost, fastest_win, avg_moves, best_streak, last_played,
           coalesce(len(ap.unlocked), 0)::INTEGER AS achievements
         FROM totals JOIN streaks USING (owner) LEFT JOIN users u USING (github_id) LEFT JOIN achievement_players ap USING (owner)
         ORDER BY games DESC, won DESC, owner
         LIMIT {LEADERBOARD_ROWS}",
        filtered_games(None, &bound_filter())
    )
}

/// One leaderboard row before the names: the owner token stays on the server.
pub struct LeaderRow {
    owner: String,
    account: AccountRow,
    games: i64,
    won: i64,
    drawn: i64,
    lost: i64,
    fastest_win: Option<i64>,
    avg_moves: f64,
    best_streak: i64,
    last_played: i64,
    achievements: i64,
}

/// The rows of the leaderboard, on the reader connection.
fn leader_rows(conn: &Connection, filter: &StatsFilter) -> ApiResult<Vec<LeaderRow>> {
    let since = since_of(filter, now_ms());
    let mode = filter.mode.map(|mode| mode.as_str());
    let level = filter.level.map(|level| level.as_str());
    let params: [(&str, &dyn ToSql); 5] =
        [("since", &since), ("mode", &mode), ("level", &level), ("account", &ACCOUNT_TOKEN_PREFIX), ("computer", &COMPUTER_TOKEN)];
    Ok(conn
        .prepare(&leaderboard_sql())?
        .query_map(params.as_slice(), |row| {
            Ok(LeaderRow {
                owner: row.get(0)?,
                account: account_row(row, 1)?,
                games: row.get(6)?,
                won: row.get(7)?,
                drawn: row.get(8)?,
                lost: row.get(9)?,
                fastest_win: row.get(10)?,
                avg_moves: row.get(11)?,
                best_streak: row.get(12)?,
                last_played: row.get(13)?,
                achievements: row.get(14)?,
            })
        })?
        .collect::<duckdb::Result<Vec<_>>>()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaderboardRow {
    person: String,
    /// The custom name, else the login, else the custom or generated name of the device: the name that the games show.
    name: String,
    player: Option<PlayerInfo>,
    games: i64,
    won: i64,
    drawn: i64,
    lost: i64,
    fastest_win: Option<i64>,
    avg_moves: Value,
    best_streak: i64,
    last_played: i64,
    achievements: i64,
}

impl Db {
    /// The leaderboard rows with their names and person ids, from the rows of the reader.
    fn named_leaders(&mut self, found: Vec<LeaderRow>) -> ApiResult<Vec<LeaderboardRow>> {
        let owners: Vec<&str> = found.iter().map(|row| row.owner.as_str()).collect();
        let names = self.names_of(&owners)?;
        found
            .into_iter()
            .map(|row| {
                let (_, login, _, custom, _) = &row.account;
                let name = custom
                    .clone()
                    .or_else(|| login.clone())
                    .unwrap_or_else(|| names.get(&row.owner).cloned().unwrap_or_else(|| name_of(&row.owner)));
                Ok(LeaderboardRow {
                    person: person_id(&row.owner),
                    name,
                    player: account_of(row.account)?,
                    games: row.games,
                    won: row.won,
                    drawn: row.drawn,
                    lost: row.lost,
                    fastest_win: row.fastest_win,
                    avg_moves: super::stats::js_number(row.avg_moves),
                    best_streak: row.best_streak,
                    last_played: row.last_played,
                    achievements: row.achievements,
                })
            })
            .collect()
    }
}

/// The leaderboard of a range, mode and level, without the caller. The unlocks come first (a write, so a store job),
/// then the board on the reader, then the names in a store job.
pub async fn leaderboard_of(store: Store, filter: StatsFilter) -> ApiResult<Value> {
    store.call(|db| db.refresh_achievements()).await?;
    let found = store.read(move |conn| leader_rows(conn, &filter)).await?;
    let rows = store.call(move |db| db.named_leaders(found)).await?;
    Ok(serde_json::json!({ "generatedAt": now_ms(), "rows": rows }))
}

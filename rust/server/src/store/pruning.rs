//! The hourly clean-up: empty sessions, stale live games and old rows.
use tick3d_core::session::{self, SessionDoc};

use super::{Db, now_ms};
use crate::error::ApiResult;

/// Reports, the moderation log and page faults go after 90 days. Moderation needs a report for a few weeks at most.
/// Revisit if a maintainer needs older reports.
const REPORTS_KEPT_MS: i64 = 90 * 24 * 3_600_000;
/// A deletion notice stays for a year, so a device that comes back within a year still cleans its copies.
/// Limit: a device that stays away longer keeps them. Revisit if players ask about it.
const DELETION_NOTICES_KEPT_MS: i64 = 365 * 24 * 3_600_000;

/// How many rows went from each table in `prune_old`.
#[derive(Debug, Default)]
pub struct OldRows {
    pub reports: usize,
    pub moderation_log: usize,
    pub events: usize,
    pub deleted_people: usize,
}

impl OldRows {
    pub fn any(&self) -> bool {
        self.reports + self.moderation_log + self.events + self.deleted_people > 0
    }
}

impl Db {
    /// Deletes the sessions that no game has a move in and that nobody changed for `age_ms`. A session with a player
    /// on the page stays, so an open page never loses its game. Returns the codes that went.
    pub fn prune_empty(&mut self, age_ms: i64) -> ApiResult<Vec<String>> {
        let mut deleted = Vec::new();
        for (code, doc) in self.sessions_older_than(age_ms)? {
            let presence = self.audience(&code, &doc)?.presence;
            if presence.x || presence.o || !session::is_empty_session(&doc) {
                continue;
            }
            self.delete_session(&code)?;
            deleted.push(code);
        }
        Ok(deleted)
    }

    /// Ends each live game that nobody changed for `age_ms` with no winner. Its replay stays, and it gets no result.
    /// A timeout that happened first counts as the timeout, and gets saved with its result.
    /// Returns the codes of the sessions with an abandoned game.
    /// Limit: each run reads every older session of the file. Revisit if a run takes more than about a second.
    pub fn abandon_stale(&mut self, age_ms: i64) -> ApiResult<Vec<String>> {
        let mut ended = Vec::new();
        let now = now_ms();
        for (code, doc) in self.sessions_older_than(age_ms)? {
            let settled = session::settle(&doc, now);
            let abandoned = session::abandon_live(settled.as_ref().unwrap_or(&doc));
            let Some(next): Option<SessionDoc> = abandoned.clone().or(settled) else { continue };
            let row = self.load_raw(&code)?;
            self.save(&row, next)?;
            if abandoned.is_some() {
                ended.push(code);
            }
        }
        Ok(ended)
    }

    /// Deletes the reports, moderation log entries and page faults after REPORTS_KEPT_MS, and the deletion notices
    /// after DELETION_NOTICES_KEPT_MS.
    pub fn prune_old(&mut self) -> ApiResult<OldRows> {
        let now = now_ms();
        let mut prune = |sql: &str, kept_ms: i64| self.execute(sql, &[("cutoff", &(now - kept_ms))]);
        Ok(OldRows {
            reports: prune("DELETE FROM reports WHERE created_at < make_timestamptz($cutoff * 1000)", REPORTS_KEPT_MS)?,
            moderation_log: prune("DELETE FROM moderation_log WHERE created_at < make_timestamptz($cutoff * 1000)", REPORTS_KEPT_MS)?,
            events: prune("DELETE FROM events WHERE created_at < make_timestamptz($cutoff * 1000)", REPORTS_KEPT_MS)?,
            deleted_people: prune(
                "DELETE FROM deleted_people WHERE deleted_at < make_timestamptz($cutoff * 1000)",
                DELETION_NOTICES_KEPT_MS,
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tick3d_core::clock::NO_LIMIT;
    use tick3d_core::game::{Cell, Status};
    use tick3d_core::session::{EMPTY_SESSION_TTL_MS, MoveRequest, STALE_GAME_MS};

    use super::super::{Hooks, Store};

    /// No page has a session open.
    struct NoPages;
    impl Hooks for NoPages {
        fn open_tokens(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn changed(&self, _: &str) {}
    }

    const TOKEN: &str = "0123456789abcdef-pruning";

    #[tokio::test]
    async fn prunes_old_empty_sessions_and_abandons_stale_games() {
        let dir = std::env::temp_dir().join(format!("tick3d-pruning-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(path.to_str().unwrap(), Arc::new(NoPages)).unwrap();
        let (deleted, abandoned, kept) = store
            .call(|db| {
                let empty = db.create(TOKEN, "empty", NO_LIMIT)?.code;
                let fresh = db.create(TOKEN, "fresh", NO_LIMIT)?.code;
                let played = db.create(TOKEN, "played", NO_LIMIT)?.code;
                let request = MoveRequest { game: 0, move_count: 0, cell: Cell::try_from(0).unwrap() };
                db.change(&played, TOKEN, |doc, identity, _| tick3d_core::session::play_move(doc, identity, &request, super::now_ms()))?;
                db.age_session(&empty, EMPTY_SESSION_TTL_MS + 1000);
                db.age_session(&played, STALE_GAME_MS + 1000);
                let deleted = db.prune_empty(EMPTY_SESSION_TTL_MS)?;
                let abandoned = db.abandon_stale(STALE_GAME_MS)?;
                let status = db.load(&played)?.doc.current_game().status;
                Ok((deleted == [empty], abandoned == [played], status == Status::Abandoned && db.load(&fresh).is_ok()))
            })
            .await
            .unwrap();
        assert!(deleted, "only the old empty session goes");
        assert!(abandoned, "only the stale game ends");
        assert!(kept, "the stale game ends with no winner, and the fresh session stays");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The answer to a create comes before any page watches the session; the creator is here all the same.
    #[tokio::test]
    async fn the_holder_of_a_view_counts_as_here() {
        let dir = std::env::temp_dir().join(format!("tick3d-presence-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(path.to_str().unwrap(), Arc::new(NoPages)).unwrap();
        let view = store.call(|db| db.create(TOKEN, "presence", NO_LIMIT)).await.unwrap();
        let presence = serde_json::to_value(&view).unwrap()["presence"].clone();
        assert_eq!(presence, serde_json::json!({ "X": true, "O": false }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The stop writes every changed session in one last job, and refuses every job after it.
    #[tokio::test]
    async fn the_close_writes_the_sessions_and_refuses_later_jobs() {
        let dir = std::env::temp_dir().join(format!("tick3d-close-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(path.to_str().unwrap(), Arc::new(NoPages)).unwrap();
        let code = store.call(|db| Ok(db.create(TOKEN, "closing", NO_LIMIT)?.code)).await.unwrap();
        store.call(|db| db.close()).await.unwrap();
        let written = code.clone();
        let saved: i64 = store
            .read(move |conn| Ok(conn.query_row("SELECT count(*) FROM sessions WHERE code = ?", [&written], |row| row.get(0))?))
            .await
            .unwrap();
        assert_eq!(saved, 1, "the session is in the file");
        let later = store.call(move |db| Ok(db.create(TOKEN, "too late", NO_LIMIT)?.code)).await;
        assert!(
            matches!(later, Err(crate::error::ApiError::Refusal { status, .. }) if status == axum::http::StatusCode::SERVICE_UNAVAILABLE)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Both players leave a timed game, then its clock runs out. The game ends with no player on a seat: it must not
    /// stop the server (a panicked store job exits the process and loses the sessions in memory), and it has no result.
    #[tokio::test]
    async fn a_timed_game_that_both_players_left_times_out_without_a_result() {
        use tick3d_core::clock::TimeControl;
        use tick3d_core::session::{SeatAction, join, seat};
        const OTHER: &str = "fedcba9876543210-pruning";
        let dir = std::env::temp_dir().join(format!("tick3d-seatless-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(path.to_str().unwrap(), Arc::new(NoPages)).unwrap();
        let (status, seats, results) = store
            .call(|db| {
                let clock = TimeControl { per_move: Some(5), per_game: None };
                let code = db.create(TOKEN, "seatless", clock)?.code;
                db.change(&code, OTHER, |doc, identity, _| join(doc, identity, OTHER))?;
                for (n, (token, cell)) in [(TOKEN, 0u8), (OTHER, 16), (TOKEN, 1)].into_iter().enumerate() {
                    let request = MoveRequest { game: 0, move_count: n, cell: Cell::try_from(cell).unwrap() };
                    db.change(&code, token, |doc, identity, _| tick3d_core::session::play_move(doc, identity, &request, super::now_ms()))?;
                }
                for token in [TOKEN, OTHER] {
                    db.change(&code, token, |doc, identity, watchers| seat(doc, identity, &SeatAction::Leave, watchers, super::now_ms()))?;
                }
                // The move clock ran out a minute ago: the next read settles the game.
                db.age_game(&code, 60_000);
                let row = db.load(&code)?;
                let results: i64 = db.query("SELECT count(*) FROM results", &[], |row| row.get(0))?.into_iter().next().unwrap_or(-1);
                Ok((row.doc.current_game().status, row.doc.seats.clone(), results))
            })
            .await
            .unwrap();
        assert!(matches!(status, Status::Timeout { .. }), "the clock ended the game");
        assert_eq!((seats.x, seats.o), (None, None));
        assert_eq!(results, 0, "a game without players records no result");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

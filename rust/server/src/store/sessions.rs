//! The live sessions and the results of finished games (server/store.ts: load, save, change, writeSessions,
//! queueResult, storeResults). Memory holds the current row of each live session, and the file holds the rest.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use duckdb::Connection;
use rand::RngExt;
use serde_json::{Value, json};
use tick3d_core::clock::TimeControl;
use tick3d_core::game::{LineKind, PerPlayer, Player, Status, line_kind};
use tick3d_core::session::{
    self, COMPUTER_TOKEN, GameRecord, Identity, OpenWatcher, SessionDoc, SessionError, SessionView, ViewContext, view_of,
};
use tokio::sync::oneshot;

use super::{Db, FROM_NODE, now_ms};
use crate::doc::parse_doc;
use crate::error::{ApiError, ApiResult};
use crate::ids::{ACCOUNT_TOKEN_PREFIX, person_id};
use crate::protocol::{CODE_ALPHABET, CODE_LENGTH};

/// Beyond this many rows in memory, the least recently used saved row goes.
/// Limit: the eviction scans every row. Revisit if a profile shows it, or if the API memory grows with the rows.
const MAX_SESSION_ROWS: usize = 100_000;
/// A finished game waits at most this long for the batch that writes it.
const RESULT_BATCH: Duration = Duration::from_millis(200);
/// A unique id is a few random tries away. Twenty failures mean a bug, not bad luck.
const MAX_ID_ATTEMPTS: usize = 20;
const DEVICE_GAME_ID_LENGTH: usize = 8;

#[derive(Clone)]
pub struct Row {
    pub code: String,
    pub doc: SessionDoc,
    pub version: u64,
    /// The time of the last change, for the pruning and My games.
    pub updated_at: i64,
    /// A document in an older form: the store writes it back in the current form.
    stale: bool,
}

#[derive(Default)]
pub struct Sessions {
    rows: HashMap<String, (Row, u64)>,
    /// The sessions with changes that the file does not have yet.
    dirty: HashSet<String>,
    /// The code of every session, in memory and in the file: a new code must be free, and an unknown code needs no read.
    /// Limit: one string per session that the file keeps, read on start. Revisit at about 1,000,000 sessions.
    known: HashSet<String>,
    uses: u64,
}

impl Sessions {
    pub fn load_known_codes(&mut self, conn: &Connection) -> duckdb::Result<()> {
        let mut statement = conn.prepare("FROM sessions SELECT code")?;
        self.known = statement.query_map([], |row| row.get(0))?.collect::<duckdb::Result<_>>()?;
        Ok(())
    }

    fn keep(&mut self, row: Row) -> Row {
        self.uses += 1;
        self.rows.insert(row.code.clone(), (row.clone(), self.uses));
        if self.rows.len() > MAX_SESSION_ROWS {
            // A row with unsaved changes stays until the next session write saves it.
            let oldest = self
                .rows
                .iter()
                .filter(|(code, _)| !self.dirty.contains(*code))
                .min_by_key(|(_, (_, used))| *used)
                .map(|(code, _)| code.clone());
            if let Some(code) = oldest {
                self.rows.remove(&code);
            }
        }
        row
    }
}

/// What the batch did with a game: stored now, or there before. A row from before game links has no link.
#[derive(Clone, Debug)]
pub struct ResultOutcome {
    pub stored: bool,
    pub public_id: Option<String>,
}

/// A finished game that waits for the next batch.
pub struct QueuedResult {
    pub id: String,
    pub token: String,
    /// The stored document, for the game link that the batch gives it.
    pub doc: Box<dyn Fn(&str) -> Value + Send>,
    pub finished_at: i64,
    pub public_id: Option<String>,
    /// False when the asked link must stay (an online game): a taken link is then a fault.
    pub renameable: bool,
    pub seats: PerPlayer<Option<String>>,
    pub game: GameRecord,
    pub metrics: Option<Value>,
}

type Waiter = oneshot::Sender<Result<ResultOutcome, String>>;

#[derive(Default)]
pub struct ResultQueue {
    /// By result id: two copies of one game in one batch wait for the same row.
    waiting: Vec<(QueuedResult, Vec<Waiter>)>,
    timer: bool,
}

/// What SQL cannot read from a stored game without a replay: winner, ending and line kind.
fn ending_of(game: &GameRecord) -> (Option<&'static str>, &'static str, Option<&'static str>) {
    let player = |player: Player| match player {
        Player::X => "X",
        Player::O => "O",
    };
    match game.to_game().status {
        Status::Won { winner, line } => (Some(player(winner)), "won", Some(line_name(line_kind(&line)))),
        Status::Timeout { winner } => (Some(player(winner)), "timeout", None),
        Status::Draw => (None, "draw", None),
        Status::Playing | Status::Abandoned => panic!("only a game with a result has an ending"),
    }
}

fn line_name(kind: LineKind) -> &'static str {
    match kind {
        LineKind::Axis => "axis",
        LineKind::Plane => "plane",
        LineKind::Space => "space",
    }
}

fn is_finished(game: &GameRecord) -> bool {
    matches!(game.to_game().status, Status::Won { .. } | Status::Timeout { .. } | Status::Draw)
}

pub fn new_game_id() -> String {
    // newGameId in src/protocol.ts: DEVICE_GAME_ID_LENGTH characters of the code alphabet.
    let alphabet: Vec<char> = CODE_ALPHABET.chars().collect();
    let mut random = rand::rng();
    (0..DEVICE_GAME_ID_LENGTH).map(|_| alphabet[random.random_range(0..alphabet.len())]).collect()
}

fn new_code() -> String {
    let alphabet: Vec<char> = CODE_ALPHABET.chars().collect();
    let mut random = rand::rng();
    (0..CODE_LENGTH).map(|_| alphabet[random.random_range(0..alphabet.len())]).collect()
}

/// The id of an online game in its game link: "<CODE>-<n>".
pub fn online_game_id(code: &str, index: usize) -> String {
    format!("{code}-{}", index + 1)
}

impl Db {
    fn not_found(code: &str) -> ApiError {
        ApiError::new(axum::http::StatusCode::NOT_FOUND, format!("No game with code {code}."))
    }

    pub fn load_raw(&mut self, code: &str) -> ApiResult<Row> {
        if let Some((row, _)) = self.sessions.rows.get(code) {
            let row = row.clone();
            return Ok(self.sessions.keep(row));
        }
        if !self.sessions.known.contains(code) {
            return Err(Self::not_found(code));
        }
        let found: Vec<(String, u64, i64)> = self.query(
            "FROM sessions SELECT doc::JSON::VARCHAR AS doc, version, epoch_ms(updated_at) AS updated WHERE code = $code",
            &[("code", &code)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let Some((doc, version, updated_at)) = found.into_iter().next() else { return Err(Self::not_found(code)) };
        let stored: Value = serde_json::from_str(&doc).map_err(ApiError::fault)?;
        let parsed = parse_doc(stored).map_err(|error| ApiError::fault(format!("session {code}: {error}")))?;
        Ok(self.sessions.keep(Row { code: code.to_owned(), doc: parsed.doc, version, updated_at, stale: parsed.stale }))
    }

    /// Loads a session, records a timeout that happened since the last write, and writes a document in an older
    /// form back in the current form.
    pub fn load(&mut self, code: &str) -> ApiResult<Row> {
        let row = self.load_raw(code)?;
        if let Some(settled) = session::settle(&row.doc, now_ms()) {
            return self.save(&row, settled);
        }
        if row.stale {
            let doc = row.doc.clone();
            return self.save(&row, doc);
        }
        Ok(row)
    }

    /// Keeps the new document in memory. The session write puts it in the file later.
    fn save(&mut self, row: &Row, doc: SessionDoc) -> ApiResult<Row> {
        // The same check as the file: a document that cannot be read back never goes in.
        let stored = serde_json::to_value(&doc).map_err(ApiError::fault)?;
        parse_doc(stored).map_err(|error| ApiError::fault(format!("session {} does not read back: {error}", row.code)))?;
        let now = now_ms();
        // Only the live game can end, by a move or by a timeout.
        let index = doc.games.len() - 1;
        let live = &doc.games[index];
        let ended = is_finished(live) && !row.doc.games.get(index).is_some_and(is_finished);
        if ended {
            let finished_at = if live.timed_out { now } else { live.times.last().copied().unwrap_or(now) };
            self.record_online(&row.code, &doc, index, finished_at);
        }
        let saved = self.sessions.keep(Row { code: row.code.clone(), doc, version: row.version + 1, updated_at: now, stale: false });
        self.sessions.dirty.insert(row.code.clone());
        self.hooks.changed(&row.code);
        Ok(saved)
    }

    /// The view of each identity. The audience and the players are the same for all, so they load once.
    pub fn views_of(&mut self, row: &Row, identities: &[Identity]) -> ApiResult<Vec<SessionView>> {
        let audience = self.audience(&row.code, &row.doc)?;
        let players = self.players_of(&row.doc)?;
        let now = now_ms();
        let name = |token: &str| audience.name(token);
        let person = |token: &str| audience.person(token);
        Ok(identities
            .iter()
            .map(|identity| {
                view_of(
                    &row.doc,
                    ViewContext {
                        code: &row.code,
                        version: row.version,
                        identity,
                        now,
                        audience: session::Audience {
                            presence: audience.presence,
                            watchers: &audience.watchers,
                            name: &name,
                            person: &person,
                        },
                        players: players.clone(),
                    },
                )
            })
            .collect())
    }

    /// The view of each token in one job, for the event streams of the open pages.
    pub fn views(&mut self, code: &str, tokens: &[Option<String>]) -> ApiResult<Vec<SessionView>> {
        let row = self.load(code)?;
        let identities = tokens.iter().map(|token| self.identity_of(token.as_deref())).collect::<ApiResult<Vec<_>>>()?;
        self.views_of(&row, &identities)
    }

    pub fn view(&mut self, row: &Row, identity: Identity) -> ApiResult<SessionView> {
        Ok(self.views_of(row, &[identity])?.pop().expect("one view per identity"))
    }

    /// Loads, applies one rule, saves when it changed something, and returns the caller's view.
    /// Limit: "changed" compares the documents. The TypeScript rules return the same object for no change, so a rule
    /// that returns an equal new document saves there and not here: only the version differs. Revisit if a client
    /// ever needs that version step.
    pub fn change(
        &mut self,
        code: &str,
        token: &str,
        rule: impl FnOnce(&SessionDoc, &Identity, &[OpenWatcher]) -> Result<SessionDoc, SessionError>,
    ) -> ApiResult<SessionView> {
        let row = self.load(code)?;
        let identity = self.identity_of(Some(token))?;
        let watchers = self.audience(code, &row.doc)?.watchers;
        // A rule can seat a logged-in watcher by its account token, so its row must exist first.
        for watcher in &watchers {
            if watcher.token.starts_with(ACCOUNT_TOKEN_PREFIX) {
                self.ensure_account_row(Db::account_id_in(&watcher.token))?;
            }
        }
        let next = rule(&row.doc, &identity, &watchers)?;
        let row = if next == row.doc { row } else { self.save(&row, next)? };
        self.view(&row, identity)
    }

    /// A new session. The creator takes seat X, so the creator moves first in the first game.
    pub fn create(&mut self, token: &str, name: &str, clock: TimeControl) -> ApiResult<SessionView> {
        let seat = self.seat_token_of(token)?;
        let doc = session::create_doc(name, clock, PerPlayer { x: Some(seat), o: None })?;
        for _ in 0..MAX_ID_ATTEMPTS {
            let code = new_code();
            if self.sessions.known.contains(&code) {
                continue;
            }
            // A new session lives in memory: the session write inserts it with the other changed sessions.
            self.sessions.known.insert(code.clone());
            self.sessions.keep(Row { code: code.clone(), doc: doc.clone(), version: 1, updated_at: now_ms(), stale: false });
            self.sessions.dirty.insert(code.clone());
            let row = self.load(&code)?;
            let identity = self.identity_of(Some(token))?;
            return self.view(&row, identity);
        }
        Err(ApiError::fault(format!("no free session code after {MAX_ID_ATTEMPTS} attempts")))
    }

    // ---- Results ----

    /// Records a finished game of an online session in `results`, so every mode has rows in one table.
    fn record_online(&mut self, code: &str, doc: &SessionDoc, index: usize, finished_at: i64) {
        let game = doc.games[index].clone();
        let token = doc.seats.x.clone().or_else(|| doc.seats.o.clone()).expect("a finished game has players");
        let stored = json!({ "mode": "online", "code": code, "number": index + 1, "name": doc.name, "game": game, "options": doc.options, "finishedAt": finished_at });
        // The answer waits for the batch, as in server/store.ts, but nothing reads its outcome.
        drop(self.queue_result(QueuedResult {
            // ':' is not a character of an uploaded result id, so the two kinds never meet.
            id: format!("online:{code}:{index}"),
            token,
            doc: Box::new(move |_| stored.clone()),
            finished_at,
            public_id: Some(online_game_id(code, index)),
            renameable: false,
            seats: doc.seats.clone(),
            game,
            metrics: None,
        }));
    }

    /// Adds a finished game to the next batch. The running job answers after the batch.
    pub fn queue_result(&mut self, result: QueuedResult) -> oneshot::Receiver<Result<ResultOutcome, String>> {
        let (outcome, outcome_answered) = oneshot::channel();
        let (written, written_answered) = oneshot::channel();
        // The job waits for the write; the caller can read the outcome.
        let (done, done_answered) = oneshot::channel::<Result<ResultOutcome, String>>();
        self.runtime.spawn(async move {
            let result = done_answered.await.unwrap_or_else(|_| Err("the result batch was dropped".into()));
            let _ = written.send(result.as_ref().map(|_| ()).map_err(Clone::clone));
            let _ = outcome.send(result);
        });
        self.job_writes.push(written_answered);
        match self.results.waiting.iter_mut().find(|(queued, _)| queued.id == result.id) {
            Some((_, waiters)) => waiters.push(done),
            None => self.results.waiting.push((result, vec![done])),
        }
        if !self.results.timer {
            self.results.timer = true;
            let jobs = self.jobs.clone();
            self.runtime.spawn(async move {
                tokio::time::sleep(RESULT_BATCH).await;
                let _ = jobs.send(Box::new(|db: &mut Db| db.write_results()));
            });
        }
        outcome_answered
    }

    /// Writes the waiting games in one transaction.
    pub fn write_results(&mut self) {
        self.results.timer = false;
        let batch = std::mem::take(&mut self.results.waiting);
        if batch.is_empty() {
            return;
        }
        match self.store_results(batch.iter().map(|(result, _)| result).collect()) {
            Ok(outcomes) => {
                for (result, waiters) in batch {
                    let outcome = outcomes.get(&result.id).expect("the batch has an outcome for each result").clone();
                    for (index, waiter) in waiters.into_iter().enumerate() {
                        // A second copy of a game in the batch finds the row of the first.
                        let _ = waiter.send(Ok(ResultOutcome { stored: outcome.stored && index == 0, ..outcome.clone() }));
                    }
                }
            }
            Err(error) => {
                eprintln!("result batch: {error}");
                for (_, waiters) in batch {
                    for waiter in waiters {
                        let _ = waiter.send(Err(error.clone()));
                    }
                }
            }
        }
    }

    fn store_results(&mut self, results: Vec<&QueuedResult>) -> Result<HashMap<String, ResultOutcome>, String> {
        let text = |error: duckdb::Error| error.to_string();
        let mut outcomes = HashMap::new();
        let ids: Vec<String> = results.iter().map(|result| result.id.clone()).collect();
        // A game that the file has already keeps its row and its link.
        let known: Vec<(String, Option<String>)> = self
            .query(
                "FROM results SELECT id, public_id WHERE list_contains(CAST($ids AS JSON)::VARCHAR[], id)",
                &[("ids", &super::json_list(&ids))],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(text)?;
        for (id, public_id) in known {
            outcomes.insert(id, ResultOutcome { stored: false, public_id });
        }
        let fresh: Vec<&QueuedResult> = results.into_iter().filter(|result| !outcomes.contains_key(&result.id)).collect();
        if fresh.is_empty() {
            return Ok(outcomes);
        }
        // Each new game gets a free link: the one it asks for, else a new one. Two games of one batch can ask for one link too.
        let mut links: HashMap<String, String> =
            fresh.iter().map(|result| (result.id.clone(), result.public_id.clone().unwrap_or_else(new_game_id))).collect();
        for attempt in 1.. {
            let asked: Vec<String> = links.values().cloned().collect();
            let taken: HashSet<String> = self
                .query(
                    "FROM results SELECT public_id WHERE list_contains(CAST($links AS JSON)::VARCHAR[], public_id)",
                    &[("links", &super::json_list(&asked))],
                    |row| row.get(0),
                )
                .map_err(text)?
                .into_iter()
                .collect();
            let mut used = HashSet::new();
            let mut clashes = 0;
            for result in &fresh {
                let link = links[&result.id].clone();
                if !taken.contains(&link) && used.insert(link.clone()) {
                    continue;
                }
                if !result.renameable {
                    return Err(format!("the game link {link} of result {} is taken", result.id));
                }
                links.insert(result.id.clone(), new_game_id());
                clashes += 1;
            }
            if clashes == 0 {
                break;
            }
            if attempt >= MAX_ID_ATTEMPTS {
                return Err(format!("no free game links after {MAX_ID_ATTEMPTS} attempts"));
            }
        }

        {
            let mut batch = self.conn.appender_to_catalog_and_db("result_batch", "temp", "main").map_err(text)?;
            let mut seat_batch = self.conn.appender_to_catalog_and_db("seat_batch", "temp", "main").map_err(text)?;
            for result in &fresh {
                let link = &links[&result.id];
                let (winner, ending, line) = ending_of(&result.game);
                let doc = serde_json::to_string(&(result.doc)(link)).expect("a result serializes");
                let metrics = result.metrics.as_ref().map(|metrics| serde_json::to_string(metrics).expect("metrics serialize"));
                batch
                    .append_row(duckdb::params![
                        result.id,
                        result.token,
                        doc,
                        result.finished_at,
                        link,
                        result.seats.x,
                        result.seats.o,
                        winner,
                        ending,
                        line,
                        metrics
                    ])
                    .map_err(text)?;
                for seat in [&result.seats.x, &result.seats.o].into_iter().flatten() {
                    if seat == COMPUTER_TOKEN {
                        continue;
                    }
                    seat_batch.append_row(duckdb::params![person_id(seat), seat]).map_err(text)?;
                }
            }
            batch.flush().map_err(text)?;
            seat_batch.flush().map_err(text)?;
        }
        let fields = &FROM_NODE.fields;
        let insert = format!(
            "INSERT INTO results (id, token, doc, finished_at, public_id, player_x, player_o, winner, ending, line, metrics, {}, {})
             SELECT id, token, doc::JSON::VARIANT, make_timestamptz(finished * 1000), public_id, player_x, player_o, winner, ending, line, metrics::JSON::VARIANT,
               {}, {}
             FROM result_batch
             ON CONFLICT (id) DO NOTHING RETURNING id",
            fields.game_columns, fields.metric_columns, fields.game_values_of_doc, fields.metric_values_of_metrics
        );
        let stored = (|| -> duckdb::Result<HashSet<String>> {
            let transaction = self.conn.transaction()?;
            let stored = transaction.prepare(&insert)?.query_map([], |row| row.get(0))?.collect::<duckdb::Result<_>>()?;
            transaction.execute("INSERT OR IGNORE INTO seat_people (person, token) SELECT person, token FROM seat_batch", [])?;
            transaction.commit()?;
            Ok(stored)
        })();
        self.conn.execute_batch("DELETE FROM result_batch; DELETE FROM seat_batch;").map_err(text)?;
        let stored = stored.map_err(text)?;
        for result in &fresh {
            outcomes.insert(
                result.id.clone(),
                ResultOutcome { stored: stored.contains(&result.id), public_id: Some(links[&result.id].clone()) },
            );
        }
        Ok(outcomes)
    }

    // ---- Session writes ----

    /// The codes with unsaved changes now.
    pub fn dirty_codes(&self) -> Vec<String> {
        self.sessions.dirty.iter().cloned().collect()
    }

    /// Writes these sessions, if they still have unsaved changes, in one transaction. A delete and an insert: an
    /// UPDATE of the document and the indexed seats cost about 10 times more in DuckDB. A saved row keeps its seq
    /// and created_at.
    pub fn write_sessions(&mut self, codes: &[String]) -> ApiResult<()> {
        let written: Vec<&String> = codes.iter().filter(|code| self.sessions.dirty.contains(*code)).collect();
        if written.is_empty() {
            return Ok(());
        }
        {
            let mut batch = self.conn.appender_to_catalog_and_db("session_batch", "temp", "main")?;
            for code in &written {
                let (row, _) = self
                    .sessions
                    .rows
                    .get(*code)
                    .ok_or_else(|| ApiError::fault(format!("session {code} has unsaved changes but no row in memory")))?;
                let doc = serde_json::to_string(&row.doc).map_err(ApiError::fault)?;
                batch.append_row(duckdb::params![code, doc, row.version, row.updated_at])?;
            }
            batch.flush()?;
        }
        let result = (|| -> duckdb::Result<()> {
            let transaction = self.conn.transaction()?;
            transaction.execute_batch(
                "INSERT INTO session_kept SELECT code, seq, created_at FROM sessions WHERE code IN (SELECT code FROM session_batch);
                 DELETE FROM sessions WHERE code IN (SELECT code FROM session_batch);
                 INSERT INTO sessions (code, seq, doc, version, created_at, updated_at, seat_x, seat_o)
                   SELECT b.code, coalesce(k.seq, nextval('session_order')), b.doc::JSON::VARIANT, b.version, coalesce(k.created_at, now()),
                     make_timestamptz(b.changed * 1000), json_extract_string(b.doc::JSON, '$.seats.X'), json_extract_string(b.doc::JSON, '$.seats.O')
                   FROM session_batch b LEFT JOIN session_kept k USING (code);",
            )?;
            transaction.commit()
        })();
        self.conn.execute_batch("DELETE FROM session_batch; DELETE FROM session_kept;")?;
        result?;
        for code in written {
            self.sessions.dirty.remove(code);
        }
        Ok(())
    }
}

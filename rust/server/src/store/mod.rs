//! The DuckDB file. One thread owns the write connection and runs the store jobs one at a time, as the
//! store queue of server/store.ts does. So each read-check-write job is atomic in this process.
//! Limit: this holds while one process uses the file. Two processes cannot open one DuckDB file anyway.
mod accounts;
mod achievements;
mod copies;
mod deletion;
mod games;
mod leaderboard;
mod moderation;
mod practice;
mod profile;
mod pruning;
mod reader;
mod results;
mod sessions;
mod stats;
mod testers;

pub use leaderboard::leaderboard_of;
pub use moderation::DeleteTarget;
pub use profile::GoogleProfile;
pub use stats::{everyone_stats, scoped_stats};
pub use testers::hint_of;

use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use duckdb::{Config, Connection, ToSql};
use serde::Deserialize;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};
use crate::ids::{account_token, person_id};

/// What the store tells the HTTP layer, and asks it.
pub trait Hooks: Send + Sync {
    /// The player tokens that have the session open now (its event streams).
    fn open_tokens(&self, code: &str) -> Vec<String>;
    /// Runs after every write to a session, also a write during a read (a timeout, a format upgrade).
    fn changed(&self, code: &str);
}

/// Named SQL parameters, without the `$`.
pub type Params<'a> = &'a [(&'a str, &'a dyn ToSql)];

/// The state that the store thread owns.
pub struct Db {
    conn: Connection,
    hooks: Arc<dyn Hooks>,
    jobs: mpsc::Sender<Job>,
    runtime: Handle,
    sessions: sessions::Sessions,
    results: sessions::ResultQueue,
    tokens: accounts::TokenSets,
    watcher_key: [u8; 32],
    /// The result batches that the running job waits for: its caller hears back after them.
    job_writes: Vec<oneshot::Receiver<Result<(), String>>>,
    achievement_state: achievements::AchievementState,
    reader: reader::Reader,
    /// Set by `close` at a stop: every later job is refused, so no answer reports a change that the last write missed.
    closed: bool,
}

type Job = Box<dyn FnOnce(&mut Db) + Send>;

#[derive(Clone)]
pub struct Store {
    jobs: mpsc::Sender<Job>,
    reader: reader::Reader,
}

/// Prepared statements kept per connection (duckdb-rs keeps 16 by default).
const STATEMENT_CACHE: usize = 256;

/// The GitHub account of the maintainer Yarden (login Yarden-zamir), for the migration 'tester-invites-before-links'.
const YARDEN_GITHUB_ID: i64 = 8178413;

#[derive(Deserialize)]
struct FromNode {
    schema: Vec<String>,
    fields: Fields,
    metrics: crate::protocol::MetricLists,
}

/// The lists and ranges that the metrics check reads, from TypeScript.
pub fn metric_lists() -> &'static crate::protocol::MetricLists {
    &FROM_NODE.metrics
}

/// The SQL of the copied columns of a result (server/fields.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fields {
    game_columns: String,
    metric_columns: String,
    game_values_of_doc: String,
    metric_values_of_metrics: String,
    /// The metric columns from a bound `$metrics` JSON text.
    metric_values_of_parameter: String,
    /// The metrics of a row as a struct (metricsStruct in server/fields.ts), of `results` and of `seat_metrics sm`.
    metrics_of_results: String,
    metrics_of_seat_metrics: String,
}

static FROM_NODE: std::sync::LazyLock<FromNode> =
    std::sync::LazyLock::new(|| serde_json::from_str(include_str!("../../from-node.json")).expect("from-node.json parses"));

pub fn now_ms() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after 1970");
    i64::try_from(since.as_millis()).expect("the time fits in i64")
}

impl Store {
    /// Opens the file and starts the store thread. Call it inside the tokio runtime: timers run there.
    pub fn open(path: &str, hooks: Arc<dyn Hooks>) -> duckdb::Result<Store> {
        // The API container is small, so cap memory and threads below the DuckDB defaults (80% of RAM, all cores).
        // A new file defaults to the v1.0 storage format for old readers, but VARIANT needs v1.5 storage.
        let config = Config::default().max_memory("256MB")?.threads(2)?.with("storage_compatibility_version", "v1.5.0")?;
        let conn = Connection::open_with_flags(path, config)?;
        // The stats alone prepare about 30 statements, and a DuckDB 2.0 prepare costs 10 ms or more: keep them all.
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        let reader_conn = conn.try_clone()?;
        reader_conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        let reader = reader::Reader::start(reader_conn);
        let (jobs, queue) = mpsc::channel::<Job>();
        let mut watcher_key = [0u8; 32];
        rand::fill(&mut watcher_key);
        let mut db = Db {
            conn,
            hooks,
            jobs: jobs.clone(),
            runtime: Handle::current(),
            sessions: sessions::Sessions::default(),
            results: sessions::ResultQueue::default(),
            tokens: accounts::TokenSets::default(),
            watcher_key,
            job_writes: Vec::new(),
            achievement_state: achievements::AchievementState::default(),
            reader: reader.clone(),
            closed: false,
        };
        db.prepare()?;
        // The achievements of every player against their games, once per start.
        db.check_all_achievements();
        thread::Builder::new()
            .name("store".into())
            .spawn(move || {
                for job in queue {
                    // A panic is a bug, and the unsaved sessions live on this thread. Stop the process, so it restarts
                    // clean, and never answer from a store in an unknown state.
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut db))).is_err() {
                        eprintln!("a store job panicked: the process stops");
                        std::process::exit(1);
                    }
                }
            })
            .expect("the store thread starts");
        Ok(Store { jobs, reader })
    }

    /// Runs `job` on the store thread, after the jobs before it. A job that ends a game answers after the
    /// result batch is in the file, so no result that a player saw can get lost.
    pub async fn call<R: Send + 'static>(&self, job: impl FnOnce(&mut Db) -> ApiResult<R> + Send + 'static) -> ApiResult<R> {
        let (answer, answered) = oneshot::channel();
        self.jobs
            .send(Box::new(move |db| {
                let result = if db.closed {
                    Err(ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, "The server is stopping. Try again in a moment."))
                } else {
                    job(db)
                };
                let writes = std::mem::take(&mut db.job_writes);
                // The caller can be gone (the client left). The job ran anyway, as in server/store.ts.
                let _ = answer.send((result, writes));
            }))
            .map_err(|_| ApiError::fault("the store thread stopped"))?;
        let (result, writes) = answered.await.map_err(|_| ApiError::fault("a store job panicked"))?;
        for write in writes {
            write.await.map_err(|_| ApiError::fault("a result batch was dropped"))?.map_err(ApiError::fault)?;
        }
        result
    }

    /// Runs `job` on the reader connection, after the reads before it: for the answers about every player.
    pub async fn read<R: Send + 'static>(&self, job: impl FnOnce(&Connection) -> ApiResult<R> + Send + 'static) -> ApiResult<R> {
        self.reader.call(job).await
    }
}

impl Db {
    /// The last job at a stop: writes every changed session and the waiting results, then refuses every later job.
    /// One job, so nothing can change between the write and the close.
    pub fn close(&mut self) -> ApiResult<()> {
        let changed = self.dirty_codes();
        let sessions = self.write_sessions(&changed);
        self.write_results();
        self.closed = true;
        sessions
    }

    fn prepare(&mut self) -> duckdb::Result<()> {
        for statement in &FROM_NODE.schema {
            self.conn.execute_batch(statement)?;
        }
        // DuckDB 1.5.6 could not replay ALTER ... DROP NOT NULL on `reports` from the write-ahead log, and the schema
        // runs that ALTER on every start. A checkpoint right after the schema keeps those statements out of the log.
        self.conn.execute_batch("CHECKPOINT")?;
        // The batch tables of the result and session writes: the appender fills one, one statement moves its rows on.
        self.conn.execute_batch(
            "CREATE TEMP TABLE result_batch (id VARCHAR, token VARCHAR, doc VARCHAR, finished BIGINT, public_id VARCHAR,
               player_x VARCHAR, player_o VARCHAR, winner VARCHAR, ending VARCHAR, line VARCHAR, metrics VARCHAR);
             CREATE TEMP TABLE seat_batch (person VARCHAR, token VARCHAR);
             CREATE TEMP TABLE session_batch (code VARCHAR, doc VARCHAR, version INTEGER, changed BIGINT);
             CREATE TEMP TABLE session_kept (code VARCHAR, seq BIGINT, created_at TIMESTAMPTZ);",
        )?;
        self.run_once("tester-invites-before-links", |conn| {
            conn.execute(
                "UPDATE tester_codes SET invited_by = $person WHERE claimed_at IS NOT NULL AND invited_by IS NULL AND NOT (email IS NULL AND name = 'Yarden')",
                duckdb::named_params! { "person": person_id(&account_token(YARDEN_GITHUB_ID)) },
            )?;
            Ok(())
        })?;
        self.run_once("github-logins", |conn| {
            conn.execute_batch(
                "UPDATE users SET provider = 'github' WHERE provider IS NULL;
                 INSERT INTO logins (provider, subject, github_id, label) SELECT 'github', github_id::VARCHAR, github_id, login FROM users ON CONFLICT DO NOTHING",
            )
        })?;
        self.sessions.load_known_codes(&self.conn)
    }

    /// Runs `task` once per database: the migrations table keeps the name, so a later start skips it.
    /// The task and the name go in one transaction, so a failed task runs again on the next start.
    fn run_once(&mut self, name: &str, task: impl FnOnce(&Connection) -> duckdb::Result<()>) -> duckdb::Result<()> {
        let transaction = self.conn.transaction()?;
        let added = transaction
            .execute("INSERT INTO migrations (name) VALUES ($name) ON CONFLICT DO NOTHING", duckdb::named_params! { "name": name })?;
        if added > 0 {
            task(&transaction)?;
        }
        transaction.commit()
    }

    /// A statement that can change data. Writes on the account tables drop the token sets. A write on `sessions`
    /// goes through `write_sessions` or `delete_session` instead, so it never overwrites or loses moves that only memory holds.
    pub fn execute(&mut self, sql: &str, params: Params) -> duckdb::Result<usize> {
        assert!(!sql.contains("sessions"), "an SQL write on sessions goes through write_sessions or delete_session: {sql}");
        let result = self.conn.prepare_cached(sql)?.execute(params);
        self.tokens.after_write(sql);
        result
    }

    /// Rows of a read, each through `map`.
    pub fn query<T>(&self, sql: &str, params: Params, map: impl FnMut(&duckdb::Row) -> duckdb::Result<T>) -> duckdb::Result<Vec<T>> {
        self.conn.prepare_cached(sql)?.query_map(params, map)?.collect()
    }
}

/// A list of texts as an SQL parameter: bind the JSON text and cast it, `CAST($tokens AS JSON)::VARCHAR[]`.
pub fn json_list(items: &[String]) -> String {
    serde_json::to_string(items).expect("texts serialize")
}

//! The DuckDB file. One thread owns the write connection and runs the store jobs one at a time, as the
//! store queue of server/store.ts does. So each read-check-write job is atomic in this process.
//! Limit: this holds while one process uses the file. Two processes cannot open one DuckDB file anyway.
use std::sync::mpsc;
use std::thread;

use duckdb::{Config, Connection};
use serde::Deserialize;
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};
use crate::ids::{account_token, person_id};

/// The state that the store thread owns.
pub struct Db {
    pub conn: Connection,
}

type Job = Box<dyn FnOnce(&mut Db) + Send>;

#[derive(Clone)]
pub struct Store {
    jobs: mpsc::Sender<Job>,
}

/// The GitHub account of the maintainer Yarden (login Yarden-zamir), for the migration 'tester-invites-before-links'.
const YARDEN_GITHUB_ID: i64 = 8178413;

#[derive(Deserialize)]
struct FromNode {
    schema: Vec<String>,
}

/// The schema statements of server/store.ts, from rust/server/from-node.json. Each one is idempotent and runs on every start.
fn schema() -> Vec<String> {
    let from_node: FromNode = serde_json::from_str(include_str!("../../from-node.json")).expect("from-node.json parses");
    from_node.schema
}

impl Store {
    pub fn open(path: &str) -> duckdb::Result<Store> {
        // The API container is small, so cap memory and threads below the DuckDB defaults (80% of RAM, all cores).
        // A new file defaults to the v1.0 storage format for old readers, but VARIANT needs v1.5 storage.
        let config = Config::default().max_memory("256MB")?.threads(2)?.with("storage_compatibility_version", "v1.5.0")?;
        let conn = Connection::open_with_flags(path, config)?;
        let mut db = Db { conn };
        db.prepare()?;
        let (jobs, queue) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name("store".into())
            .spawn(move || {
                for job in queue {
                    job(&mut db);
                }
            })
            .expect("the store thread starts");
        Ok(Store { jobs })
    }

    /// Runs `job` on the store thread, after the jobs before it.
    pub async fn call<R: Send + 'static>(&self, job: impl FnOnce(&mut Db) -> ApiResult<R> + Send + 'static) -> ApiResult<R> {
        let (answer, answered) = oneshot::channel();
        self.jobs
            .send(Box::new(move |db| {
                // The caller can be gone (the client left). The job ran anyway, as in server/store.ts.
                let _ = answer.send(job(db));
            }))
            .map_err(|_| ApiError::fault("the store thread stopped"))?;
        answered.await.map_err(|_| ApiError::fault("a store job panicked"))?
    }
}

impl Db {
    fn prepare(&mut self) -> duckdb::Result<()> {
        for statement in schema() {
            self.conn.execute_batch(&statement)?;
        }
        // DuckDB 1.5.6 could not replay ALTER ... DROP NOT NULL on `reports` from the write-ahead log, and the schema
        // runs that ALTER on every start. A checkpoint right after the schema keeps those statements out of the log.
        self.conn.execute_batch("CHECKPOINT")?;
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
        })
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
}

//! A second connection for the answers about every player: the achievement check, and later the Everyone stats and the
//! leaderboard. They read every game, so they run on their own thread, one at a time,
//! and the store jobs never wait for them. Each read sees a consistent view of the data while the store thread writes.
use std::sync::mpsc;
use std::thread;

use duckdb::Connection;
use tokio::sync::oneshot;

use crate::error::{ApiError, ApiResult};

type ReadJob = Box<dyn FnOnce(&Connection) + Send>;

#[derive(Clone)]
pub struct Reader {
    jobs: mpsc::Sender<ReadJob>,
}

impl Reader {
    pub(super) fn start(conn: Connection) -> Reader {
        let (jobs, queue) = mpsc::channel::<ReadJob>();
        thread::Builder::new()
            .name("reader".into())
            .spawn(move || {
                for job in queue {
                    // A read holds no state, so a panic fails only its own call (the dropped answer), and the thread goes on.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&conn)));
                }
            })
            .expect("the reader thread starts");
        Reader { jobs }
    }

    /// Runs `job` on the reader thread, after the reads before it.
    pub async fn call<R: Send + 'static>(&self, job: impl FnOnce(&Connection) -> ApiResult<R> + Send + 'static) -> ApiResult<R> {
        let (answer, answered) = oneshot::channel();
        self.jobs
            .send(Box::new(move |conn| {
                let _ = answer.send(job(conn));
            }))
            .map_err(|_| ApiError::fault("the reader thread stopped"))?;
        answered.await.map_err(|_| ApiError::fault("a read job panicked"))?
    }
}

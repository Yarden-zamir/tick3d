//! The tick3d API server in Rust (#265): the same routes as server/main.ts, against the same DuckDB file.
mod doc;
mod docs;
mod error;
mod ids;
mod limits;
mod live;
mod protocol;
mod routes;
mod sessions;
mod store;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

use crate::live::Live;
use crate::store::Store;

/// The state that every route shares.
#[derive(Clone)]
pub struct App(Arc<AppState>);

pub struct AppState {
    pub store: Store,
    pub live: Arc<Live>,
    /// LAN_HOST=1 marks a server that a player runs on their own computer for a local network.
    pub lan_host: Option<String>,
}

impl std::ops::Deref for App {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.0
    }
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn lan_host() -> Option<String> {
    if std::env::var("LAN_HOST").as_deref() != Ok("1") {
        return None;
    }
    let name = std::env::var("LAN_HOST_NAME").ok().filter(|name| !name.is_empty());
    Some(name.unwrap_or_else(|| std::fs::read_to_string("/etc/hostname").unwrap_or_default().trim().to_owned()))
}

/// The changed sessions in memory reach the file this often, so a crash loses at most about this much play.
/// Each job writes at most SESSION_WRITE_CHUNK of them, so a move waits for one chunk at most.
const SESSION_WRITE: Duration = Duration::from_secs(60);
const SESSION_WRITE_CHUNK: usize = 500;
/// The requests that run at a stop get this long to answer, so a move during a deploy counts. Then the process cuts
/// the connections that still wait: long polls and Nearby announcements. Their clients ask again.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

async fn write_changed_sessions(store: &Store) {
    let changed = match store.call(|db| Ok(db.dirty_codes())).await {
        Ok(changed) => changed,
        Err(error) => return eprintln!("session write: {error:?}"),
    };
    for chunk in changed.chunks(SESSION_WRITE_CHUNK) {
        let chunk = chunk.to_vec();
        if let Err(error) = store.call(move |db| db.write_sessions(&chunk)).await {
            eprintln!("session write: {error:?}");
        }
    }
}

#[tokio::main]
async fn main() {
    // PORT lets a test run its own server next to another one.
    let port: u16 = std::env::var("PORT").map_or(8080, |port| port.parse().expect("PORT is a port number"));
    let db_path = required_env("DB_PATH");
    let live = Live::new();
    let store = Store::open(&db_path, live.clone()).expect("the database opens");
    live.set_store(store.clone());
    let app = App(Arc::new(AppState { store: store.clone(), live: live.clone(), lan_host: lan_host() }));
    let writer = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SESSION_WRITE);
        interval.tick().await;
        loop {
            interval.tick().await;
            write_changed_sessions(&writer).await;
        }
    });
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("the port is free");
    println!("tick3d api (rust) on :{port}, db {db_path}");
    let service = routes::router(app).into_make_service_with_connect_info::<SocketAddr>();
    let (stop, stopping) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, service)
            .with_graceful_shutdown(async {
                stopping.await.ok();
            })
            .await
            .expect("the server runs");
    });
    stopped().await;
    // The pages open a new stream after the retry time of the stream, and the proxies hold it until the next process answers.
    live.close_all();
    let _ = stop.send(());
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, server).await;
    write_changed_sessions(&store).await;
    if let Err(error) = store
        .call(|db| {
            db.write_results();
            Ok(())
        })
        .await
    {
        eprintln!("result write at the stop: {error:?}");
    }
}

/// A deploy stops this process with SIGTERM.
async fn stopped() {
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

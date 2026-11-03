//! The tick3d API server in Rust (#265): the same routes as server/main.ts, against the same DuckDB file.
mod account;
mod achievements;
mod auth;
mod doc;
mod docs;
mod error;
mod games;
mod idempotency;
mod ids;
mod limits;
mod live;
mod login;
mod moderation;
mod nearby;
mod practice;
mod previews;
mod protocol;
mod results;
mod routes;
mod sessions;
mod signal;
mod snapshots;
mod stats;
mod store;
mod tester_codes;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tick3d_core::session;
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
    pub idempotency: Arc<idempotency::Idempotency>,
    /// None when login is off.
    pub auth: Option<auth::Auth>,
    /// LAN_HOST=1 marks a server that a player runs on their own computer for a local network.
    pub lan_host: Option<String>,
    pub lobby: nearby::Lobby,
    /// None on a server without previews (a LAN host).
    pub previews: Option<previews::Previews>,
    /// The last answers of the Everyone stats and the leaderboard.
    pub snapshots: snapshots::Snapshots,
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

/// The clean-up runs at start and then this often.
const PRUNE: Duration = Duration::from_secs(3600);

/// Sessions that nobody played go after a while, and so do old reports, moderation log entries, page faults and
/// deletion notices. A live game with no change for STALE_GAME_MS ends with no winner.
async fn prune(store: &Store) {
    let pruned = store
        .call(|db| {
            let deleted = db.prune_empty(session::EMPTY_SESSION_TTL_MS)?;
            let abandoned = db.abandon_stale(session::STALE_GAME_MS)?;
            Ok((deleted, abandoned, db.prune_old()?))
        })
        .await;
    match pruned {
        Ok((deleted, abandoned, old)) => {
            if !deleted.is_empty() {
                println!("pruned {} empty sessions", deleted.len());
            }
            if !abandoned.is_empty() {
                println!("abandoned {} stale games", abandoned.len());
            }
            if old.any() {
                println!("pruned old rows {old:?}");
            }
        }
        Err(error) => eprintln!("pruning failed: {error:?}"),
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
    // The tester codes of TESTER_CODES. A bad entry stops the start.
    let codes = tester_codes::tester_codes_from_env().unwrap_or_else(|error| panic!("{error}"));
    if !codes.is_empty() {
        let total = codes.len();
        let added = store.call(move |db| db.add_tester_codes(&codes)).await.expect("the tester codes are stored");
        println!("tester codes: {added} new of {total}");
    }
    // The release of this build (src/release.ts). The image holds release.json in the working directory, as the Node
    // image holds it next to server/. A local server has no build, so it records no release. A bad file stops the start.
    match std::fs::read_to_string("release.json") {
        Ok(text) => {
            let value: serde_json::Value =
                serde_json::from_str(&text).unwrap_or_else(|error| panic!("release.json does not parse: {error}"));
            let release = protocol::parse_release(&value).unwrap_or_else(|error| panic!("{error}"));
            let line = format!("release {}: {}", release.version, release.name);
            let added = store.call(move |db| db.add_release(&release)).await.expect("the release is stored");
            println!("{line}{}", if added { " (new)" } else { "" });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => println!("no release.json: this build records no release"),
        Err(error) => panic!("release.json cannot be read: {error}"),
    }
    let app = App(Arc::new(AppState {
        store: store.clone(),
        live: live.clone(),
        idempotency: Arc::default(),
        auth: auth::AuthConfig::from_env().map(auth::Auth::new),
        lan_host: lan_host(),
        lobby: nearby::Lobby::default(),
        previews: previews::previews_config_from_env().unwrap_or_else(|error| panic!("{error}")).map(previews::Previews::new),
        snapshots: snapshots::Snapshots::default(),
    }));
    let writer = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SESSION_WRITE);
        interval.tick().await;
        loop {
            interval.tick().await;
            write_changed_sessions(&writer).await;
        }
    });
    let pruner = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PRUNE);
        loop {
            interval.tick().await;
            prune(&pruner).await;
        }
    });
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("the port is free");
    println!("tick3d api (rust) on :{port}, db {db_path}, login {}", if app.auth.is_some() { "on" } else { "off" });
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

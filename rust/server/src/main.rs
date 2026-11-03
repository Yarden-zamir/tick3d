//! The tick3d API server in Rust (#265): the same routes as server/main.ts, against the same DuckDB file.
mod docs;
mod error;
mod ids;
mod routes;
mod store;

use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

use crate::store::Store;

/// The state that every route shares.
#[derive(Clone)]
pub struct App(Arc<AppState>);

pub struct AppState {
    pub store: Store,
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

#[tokio::main]
async fn main() {
    // PORT lets a test run its own server next to another one.
    let port: u16 = std::env::var("PORT").map_or(8080, |port| port.parse().expect("PORT is a port number"));
    let db_path = required_env("DB_PATH");
    let store = Store::open(&db_path).expect("the database opens");
    let app = App(Arc::new(AppState { store, lan_host: lan_host() }));
    let listener = TcpListener::bind(("0.0.0.0", port)).await.expect("the port is free");
    println!("tick3d api (rust) on :{port}, db {db_path}");
    axum::serve(listener, routes::router(app)).with_graceful_shutdown(stopped()).await.expect("the server runs");
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

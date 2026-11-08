//! In-process benchmarks of the units of a move: the rules, the store, the router and the fan-out to open pages.
//! They need no network and no second machine, so no proxy and no limit per address takes part.
//! Run them in release mode, one at a time:
//! cargo test --release -p tick3d-server bench_ -- --ignored --nocapture --test-threads 1
//! Each one prints a JSON line. BENCH_GAMES sets the number of games (default 2000).
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use serde_json::{Value, json};
use tick3d_core::clock::NO_LIMIT;
use tick3d_core::game::PerPlayer;
use tick3d_core::session::{self, Identity, MoveRequest};
use tokio_stream::StreamExt;
use tower::ServiceExt;

use crate::live::Live;
use crate::store::Store;
use crate::{App, AppState, nearby, play_proof, routes, snapshots};

/// X 0 1 2 3 and O 16 17 18: X wins with the 7th move.
const MOVES: [u8; 7] = [0, 16, 1, 17, 2, 18, 3];

fn games() -> usize {
    std::env::var("BENCH_GAMES").ok().and_then(|text| text.parse().ok()).unwrap_or(2000)
}

/// The median, p90, p99 and max of the samples, in microseconds.
fn summary(name: &str, mut samples: Vec<Duration>, extra: Value) {
    samples.sort();
    let at = |p: f64| samples[((samples.len() - 1) as f64 * p).round() as usize].as_secs_f64() * 1e6;
    let total: f64 = samples.iter().map(Duration::as_secs_f64).sum();
    println!(
        "{}",
        json!({ "bench": name, "n": samples.len(), "p50Us": at(0.5).round(), "p90Us": at(0.9).round(), "p99Us": at(0.99).round(),
            "maxUs": at(1.0).round(), "perSecond": (samples.len() as f64 / total).round(), "extra": extra })
    );
}

fn identity(token: &str) -> Identity {
    HashSet::from([token.to_owned()])
}

async fn app() -> (App, Store) {
    let dir = std::env::temp_dir().join(format!("tick3d-bench-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    let live = Live::new();
    let store = Store::open(dir.join("b.duckdb").to_str().unwrap(), live.clone()).unwrap();
    live.set_store(store.clone());
    let app = App(Arc::new(AppState {
        store: store.clone(),
        live,
        idempotency: Arc::default(),
        auth: None,
        lan_host: None,
        lobby: nearby::Lobby::default(),
        previews: None,
        snapshots: snapshots::Snapshots::default(),
        play: play_proof::PlayProof::from_env().unwrap(),
        apple: None,
        stores: crate::stores::Stores::default(),
    }));
    (app, store)
}

/// A token of the form the page makes: 16 hex characters, a dash and a name.
fn token(n: usize) -> String {
    format!("{n:016x}-bench")
}

/// The session rules alone (rust/core): a full game of 7 moves on a document, no store.
#[test]
#[ignore = "a benchmark"]
fn bench_rules() {
    let mut samples = Vec::new();
    for _ in 0..games() * 10 {
        let mut doc = session::create_doc("Bench", NO_LIMIT, PerPlayer { x: Some("a".into()), o: Some("b".into()) }).unwrap();
        for (n, cell) in MOVES.into_iter().enumerate() {
            let who = identity(if n % 2 == 0 { "a" } else { "b" });
            let started = Instant::now();
            doc = session::play_move(&doc, &who, &MoveRequest { game: 0, move_count: n, cell: cell.try_into().unwrap() }, 1).unwrap();
            samples.push(started.elapsed());
        }
    }
    summary("rules: one move", samples, json!({}));
}

/// The store job of a move (load, rules, save in memory, the view), through the store thread. The finished game goes
/// to the result batch, which writes DuckDB in the background.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark"]
async fn bench_store() {
    let (_app, store) = app().await;
    let (mut samples, mut ends) = (Vec::new(), Vec::new());
    for game in 0..games() {
        let (a, b) = (token(game * 2), token(game * 2 + 1));
        let created = {
            let a = a.clone();
            store.call(move |db| db.create(&a, "Bench", NO_LIMIT)).await.unwrap()
        };
        let code = created.code.to_string();
        {
            let (code, b) = (code.clone(), b.clone());
            store
                .call(move |db| {
                    let seat = db.seat_token_of(&b)?;
                    db.change(&code, &b, |doc, who, _| session::join(doc, who, &seat))
                })
                .await
                .unwrap();
        }
        for (n, cell) in MOVES.into_iter().enumerate() {
            let (code, mover) = (code.clone(), if n % 2 == 0 { a.clone() } else { b.clone() });
            let request = MoveRequest { game: 0, move_count: n, cell: cell.try_into().unwrap() };
            let started = Instant::now();
            store.call(move |db| db.change(&code, &mover, |doc, who, _| session::play_move(doc, who, &request, 1))).await.unwrap();
            if n + 1 == MOVES.len() { ends.push(started.elapsed()) } else { samples.push(started.elapsed()) }
        }
    }
    summary("store: one move", samples, json!({}));
    // The answer of the move that ends a game waits for the result batch, which writes the game to DuckDB.
    summary("store: the move that ends a game", ends, json!({}));
}

fn post(path: &str, token: &str, body: Value, client: usize) -> Request {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("x-player", token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    // One address per game: the limits count new games per address.
    let ip = [10, (client >> 16) as u8, (client >> 8) as u8, client as u8];
    request.extensions_mut().insert(ConnectInfo(SocketAddr::from((ip, 9))));
    request
}

/// A move request through the whole router: the body, the checks, the handler, the store and the JSON answer.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark"]
async fn bench_router() {
    let (app, _store) = app().await;
    let router = routes::router(app);
    let (mut samples, mut ends) = (Vec::new(), Vec::new());
    for game in 0..games() {
        let (a, b) = (token(game * 2), token(game * 2 + 1));
        let answer = router.clone().oneshot(post("/api/sessions", &a, json!({ "name": "Bench" }), game)).await.unwrap();
        assert_eq!(answer.status(), 201);
        let created: Value = serde_json::from_slice(&axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap()).unwrap();
        let code = created["code"].as_str().unwrap().to_owned();
        let joined = router.clone().oneshot(post(&format!("/api/sessions/{code}/join"), &b, json!({}), game)).await.unwrap();
        assert_eq!(joined.status(), 200);
        for (n, cell) in MOVES.into_iter().enumerate() {
            let mover = if n % 2 == 0 { &a } else { &b };
            let request = post(&format!("/api/sessions/{code}/moves"), mover, json!({ "game": 0, "moveCount": n, "cell": cell }), game);
            let started = Instant::now();
            let answer = router.clone().oneshot(request).await.unwrap();
            let status = answer.status();
            let _ = axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap();
            if n + 1 == MOVES.len() {
                ends.push(started.elapsed())
            } else {
                samples.push(started.elapsed())
            }
            assert_eq!(status, 200);
        }
    }
    summary("router: one move request", samples, json!({}));
    summary("router: the move request that ends a game", ends, json!({}));
}

/// The fan-out of one move to the open pages of a session: from the start of the move until every page has its new
/// view. Each watcher has its own token, so the server builds a view for each, as for real watchers.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark"]
async fn bench_fan_out() {
    for watchers in [1usize, 10, 100, 1000] {
        let (app, store) = app().await;
        let (a, b) = (token(1), token(2));
        let created = {
            let a = a.clone();
            store.call(move |db| db.create(&a, "Bench", NO_LIMIT)).await.unwrap()
        };
        let code = created.code.to_string();
        {
            let (code, b) = (code.clone(), b.clone());
            store
                .call(move |db| {
                    let seat = db.seat_token_of(&b)?;
                    db.change(&code, &b, |doc, who, _| session::join(doc, who, &seat))
                })
                .await
                .unwrap();
        }
        let mut streams = Vec::new();
        for n in 0..watchers {
            streams.push(app.live.open(&code, Some(token(1000 + n)), None).unwrap());
        }
        let mut samples = Vec::new();
        for (n, cell) in MOVES.into_iter().take(6).enumerate() {
            // Let the pushes of the opens and of the last move end, then empty every stream.
            tokio::time::sleep(Duration::from_millis(200)).await;
            for stream in &mut streams {
                while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(1), stream.next()).await {}
            }
            let (code, mover) = (code.clone(), if n % 2 == 0 { a.clone() } else { b.clone() });
            let request = MoveRequest { game: 0, move_count: n, cell: cell.try_into().unwrap() };
            let started = Instant::now();
            let moved =
                store.call(move |db| db.change(&code, &mover, |doc, who, _| session::play_move(doc, who, &request, 1))).await.unwrap();
            for stream in &mut streams {
                loop {
                    let message = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.unwrap().unwrap();
                    let view: Value = serde_json::from_str(&message).unwrap_or(Value::Null);
                    if view["version"].as_u64() >= Some(moved.version) {
                        break;
                    }
                }
            }
            samples.push(started.elapsed());
        }
        summary("fan-out: one move to every open page", samples, json!({ "watchers": watchers }));
    }
}

//! The Idempotency-Key header: a repeat of a keyed request gets the first answer, and
//! changes nothing. A key counts per player and path for IDEMPOTENCY_TTL.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::App;
use crate::error::ApiError;
use crate::ids::sha256_hex;
use crate::sessions::{MAX_BODY_BYTES, player_of};
use crate::store::now_ms;

const KEY_MAX_LENGTH: usize = 255;
const TTL_MS: i64 = 3_600_000;
/// An answer is a few kB, so 5000 keys keep the memory small. Revisit this when keys go before their time
/// (more than 5000 changes per hour).
const MAX_KEYS: usize = 5000;

#[derive(Clone)]
struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

struct Entry {
    request: String,
    /// None while the first request runs.
    answer: Option<Answer>,
    expires_at: i64,
    /// Tells this entry from a newer one with the same id.
    serial: u64,
}

#[derive(Default)]
pub struct Idempotency {
    entries: Mutex<(HashMap<String, Entry>, VecDeque<String>, u64)>,
}

enum Claim {
    Run(u64),
    Replay(Answer),
    Mismatch,
    Running,
}

fn parse_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let mut values = headers.get_all("idempotency-key").iter();
    let Some(value) = values.next() else { return Ok(None) };
    if values.next().is_some() {
        return Err(ApiError::bad_request("Send one Idempotency-Key header."));
    }
    let invalid = || {
        ApiError::bad_request(format!(
            "An Idempotency-Key has 1 to {KEY_MAX_LENGTH} visible ASCII characters, without quotes or backslashes."
        ))
    };
    let header = value.to_str().map_err(|_| invalid())?;
    let quoted = header.len() >= 2 && header.starts_with('"') && header.ends_with('"');
    let key = if quoted { &header[1..header.len() - 1] } else { header };
    let visible = key.chars().all(|char| ('!'..='~').contains(&char) && char != '"' && char != '\\');
    if key.is_empty() || key.len() > KEY_MAX_LENGTH || !visible {
        return Err(invalid());
    }
    Ok(Some(key.to_owned()))
}

impl Idempotency {
    fn claim(&self, id: &str, request: &str, now: i64) -> Claim {
        let mut guard = self.entries.lock().expect("the idempotency lock is not poisoned");
        let (entries, order, serials) = &mut *guard;
        if let Some(found) = entries.get(id)
            && found.expires_at > now
        {
            if found.request != request {
                return Claim::Mismatch;
            }
            return found.answer.clone().map_or(Claim::Running, Claim::Replay);
        }
        entries.remove(id);
        order.retain(|known| known != id);
        if entries.len() >= MAX_KEYS
            && let Some(oldest) = order.pop_front()
        {
            entries.remove(&oldest);
        }
        *serials += 1;
        entries.insert(id.to_owned(), Entry { request: request.to_owned(), answer: None, expires_at: now + TTL_MS, serial: *serials });
        order.push_back(id.to_owned());
        Claim::Run(*serials)
    }

    fn finish(&self, id: &str, serial: u64, answer: Option<Answer>) {
        let mut guard = self.entries.lock().expect("the idempotency lock is not poisoned");
        let (entries, order, _) = &mut *guard;
        let Some(entry) = entries.get_mut(id).filter(|entry| entry.serial == serial) else { return };
        match answer {
            Some(answer) => entry.answer = Some(answer),
            None => {
                entries.remove(id);
                order.retain(|known| known != id);
            }
        }
    }
}

/// Frees the key of a request that ends without an answer: the client left, for example.
struct Running {
    idempotency: Arc<Idempotency>,
    id: String,
    serial: u64,
    done: bool,
}

impl Running {
    /// Records the answer, so a retry with the key replays it.
    fn answered(mut self, answer: Answer) {
        self.idempotency.finish(&self.id, self.serial, Some(answer));
        self.done = true;
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if !self.done {
            self.idempotency.finish(&self.id, self.serial, None);
        }
    }
}

/// The middleware of each route that accepts the header. Without a valid X-Player header, the route refuses the
/// request itself, so nothing is stored.
pub async fn keyed(State(app): State<App>, request: Request, next: Next) -> Response {
    let key = match parse_key(request.headers()) {
        Ok(Some(key)) => key,
        Ok(None) => return next.run(request).await,
        Err(error) => return error.into_response(),
    };
    let Some(player) = player_of(request.headers()) else { return next.run(request).await };
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        return ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large.").into_response();
    };
    let path = parts.uri.path().to_owned();
    let digest = sha256_hex(&body);
    let fingerprint = format!("{} {path}\n{digest}", parts.method);
    let id = format!("{player}\n{path}\n{key}");
    let serial = match app.idempotency.claim(&id, &fingerprint, now_ms()) {
        Claim::Mismatch => {
            return ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "This Idempotency-Key came with another request before. Use a new key for a new request.",
            )
            .into_response();
        }
        Claim::Running => {
            return ApiError::new(StatusCode::CONFLICT, "The first request with this Idempotency-Key still runs. Try again in a moment.")
                .into_response();
        }
        Claim::Replay(answer) => return (answer.status, answer.headers, answer.body).into_response(),
        Claim::Run(serial) => serial,
    };
    let running = Running { idempotency: Arc::clone(&app.idempotency), id, serial, done: false };
    // The request runs in its own task: a client that leaves drops this future, but a store job that started still
    // changes the data. The task records the answer anyway, so a retry with the key replays it instead of running again.
    let task = tokio::spawn(async move {
        let response = next.run(Request::from_parts(parts, Body::from(body))).await;
        let (mut parts, body) = response.into_parts();
        let Ok(body) = axum::body::to_bytes(body, usize::MAX).await else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        // A server error is not the answer to the request, so a retry runs it again.
        if !parts.status.is_server_error() {
            parts.headers.remove(axum::http::header::CONTENT_LENGTH);
            running.answered(Answer { status: parts.status, headers: parts.headers.clone(), body: body.clone() });
        }
        Response::from_parts(parts, Body::from(body))
    });
    task.await.unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::task::Poll;

    use axum::body::Body;
    use axum::extract::{ConnectInfo, Request};
    use axum::http::StatusCode;
    use tower::ServiceExt;

    use crate::{App, AppState, live::Live, nearby, play_proof, routes, snapshots, store::Store};

    fn create(key: &str) -> Request {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/sessions")
            .header("x-player", "0123456789abcdef-keyed1")
            .header("idempotency-key", key)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"name":"keyed"}"#))
            .expect("a request");
        request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 9))));
        request
    }

    /// A client that leaves after the request started must not let a retry with the same key run it a second time.
    #[tokio::test]
    async fn a_request_that_its_client_left_still_records_its_answer() {
        let dir = std::env::temp_dir().join(format!("tick3d-keyed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let live = Live::new();
        let store = Store::open(path.to_str().unwrap(), live.clone()).unwrap();
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
        }));
        let router = routes::router(app);
        // Poll the first request once, so it starts, then drop it, as a client that leaves.
        {
            let mut first = std::pin::pin!(router.clone().oneshot(create("k1")));
            std::future::poll_fn(|cx| {
                let _ = first.as_mut().poll(cx);
                Poll::Ready(())
            })
            .await;
        }
        // The retry waits while the first one still runs (409), then replays its answer.
        let mut retry = router.clone().oneshot(create("k1")).await.unwrap();
        for _ in 0..50 {
            if retry.status() != StatusCode::CONFLICT {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            retry = router.clone().oneshot(create("k1")).await.unwrap();
        }
        assert_eq!(retry.status(), StatusCode::CREATED);
        let sessions = store.call(|db| Ok(db.session_count())).await.unwrap();
        assert_eq!(sessions, 1, "the operation ran once");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

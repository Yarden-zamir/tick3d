//! The Idempotency-Key header (server/idempotency.ts): a repeat of a keyed request gets the first answer, and
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
    let mut running = Running { idempotency: Arc::clone(&app.idempotency), id, serial, done: false };
    let response = next.run(Request::from_parts(parts, Body::from(body))).await;
    let (mut parts, body) = response.into_parts();
    let Ok(body) = axum::body::to_bytes(body, usize::MAX).await else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    // A server error is not the answer to the request, so a retry runs it again.
    if !parts.status.is_server_error() {
        parts.headers.remove(axum::http::header::CONTENT_LENGTH);
        running.idempotency.finish(
            &running.id,
            serial,
            Some(Answer { status: parts.status, headers: parts.headers.clone(), body: body.clone() }),
        );
        running.done = true;
    }
    Response::from_parts(parts, Body::from(body))
}

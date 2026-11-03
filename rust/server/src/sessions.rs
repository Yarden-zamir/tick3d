//! The routes of online sessions (server/main.ts: POST /api/sessions and /api/sessions/{code}/...).
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use serde::Deserialize;
use serde_json::Value;
use tick3d_core::session::{self, SessionView};
use tokio_stream::StreamExt;

use crate::App;
use crate::error::{ApiError, ApiResult, no_store};
use crate::limits::{Limiter, client_of};
use crate::protocol::{
    as_player_token, normalize_code, parse_move_request, parse_new_session, parse_playoff_request, parse_seat_action, parse_seat_answer,
    parse_session_update,
};
use crate::store::now_ms;

pub const MAX_BODY_BYTES: usize = 4096;

/// Session codes are never freed, so one client must not use them all up: 60 new sessions per hour (CREATES_PER_HOUR).
static ALLOW_CREATE: Limiter = Limiter::new(60, 3_600_000, 10_000, "Too many new games from this address. Try again later.");

/// The body of a request as JSON. An empty body reads as `{}`.
pub async fn read_json(body: Body, limit: usize) -> ApiResult<Value> {
    let bytes =
        axum::body::to_bytes(body, limit).await.map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large."))?;
    json_of(&bytes)
}

pub fn json_of(bytes: &Bytes) -> ApiResult<Value> {
    if bytes.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(bytes).map_err(|_| ApiError::bad_request("Request body is not valid JSON."))
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The X-Player header, when it is a valid player token.
pub fn player_of(headers: &HeaderMap) -> Option<String> {
    header_text(headers, "x-player").and_then(as_player_token)
}

pub fn require_player(headers: &HeaderMap) -> ApiResult<String> {
    player_of(headers).ok_or_else(|| ApiError::bad_request("Missing or invalid X-Player header."))
}

fn session_code(code: &str) -> ApiResult<String> {
    normalize_code(code).ok_or_else(|| ApiError::bad_request("A code has 4 letters or digits."))
}

pub fn ok_json<T: serde::Serialize>(status: StatusCode, body: &T) -> Response {
    (status, no_store(), Json(body)).into_response()
}

fn view(view: SessionView) -> Response {
    ok_json(StatusCode::OK, &view)
}

pub async fn create(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_CREATE.allow(&client_of(&headers, peer), now_ms())?;
    let request = parse_new_session(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("A new game needs a name of 1 to 40 characters, and a valid clock or none."))?;
    let token = require_player(&headers)?;
    let created = app.store.call(move |db| db.create(&token, &request.name, request.clock)).await?;
    Ok(ok_json(StatusCode::CREATED, &created))
}

#[derive(Deserialize)]
pub struct GetQuery {
    wait: Option<String>,
}

pub async fn get(
    State(app): State<App>,
    Path(code): Path<String>,
    Query(query): Query<GetQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let token = player_of(&headers);
    let code = session_code(&code)?;
    // GET /api/sessions/{code}?wait=<version> holds the request until the version is greater, or WAIT passes.
    if let Some(wait) = query.wait {
        let since = wait.parse::<u64>().ok().filter(|_| wait.chars().all(|char| char.is_ascii_digit()));
        let since = since.ok_or_else(|| ApiError::bad_request("wait needs a version: a whole number of 0 or more."))?;
        app.live.wait_for_change(&code, since).await?;
    }
    Ok(view(
        app.store
            .call(move |db| {
                let row = db.load(&code)?;
                let identity = db.identity_of(token.as_deref())?;
                db.view(&row, identity)
            })
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct StreamQuery {
    player: Option<String>,
    stream: Option<String>,
}

/// EventSource cannot send headers, so the stream takes the player token from the query string.
/// Caddy keeps no access log for this site; revisit this if logging is ever turned on.
pub async fn events(State(app): State<App>, Path(code): Path<String>, Query(query): Query<StreamQuery>) -> ApiResult<Response> {
    let code = session_code(&code)?;
    let token = query.player.as_deref().and_then(as_player_token);
    // 404 before the stream opens.
    let known = code.clone();
    app.store.call(move |db| db.load(&known).map(drop)).await?;
    let stream = app.live.open(&code, token, query.stream)?;
    let events = tokio_stream::once(Event::default().retry(Duration::from_millis(3000)))
        .chain(stream.map(|message| Event::default().data(message)))
        .map(Ok::<Event, Infallible>);
    // Comments keep idle event streams open through proxies.
    let sse = Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)).text("ping"));
    Ok(([(header::CACHE_CONTROL, "no-store")], sse).into_response())
}

pub async fn leave(State(app): State<App>, Path(code): Path<String>, Query(query): Query<StreamQuery>) -> ApiResult<Response> {
    let code = session_code(&code)?;
    let token = query.player.as_deref().and_then(as_player_token);
    let (Some(token), Some(id)) = (token, query.stream.filter(|id| !id.is_empty())) else {
        return Err(ApiError::bad_request("player or stream is missing."));
    };
    app.live.leave(&code, &token, &id);
    Ok(([(header::CACHE_CONTROL, "no-store")], StatusCode::OK).into_response())
}

pub async fn update(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let changes = parse_session_update(&read_json(body, MAX_BODY_BYTES).await?).ok_or_else(|| {
        ApiError::bad_request("An update needs a name of 1 to 40 characters, hideBoard, hideHistory, hideCoordinates, fixedSeats, watcherChat or a valid clock.")
    })?;
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(app.store.call(move |db| db.change(&code, &token, |doc, identity, _| session::update(doc, identity, &changes))).await?))
}

pub async fn lock(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(app.store.call(move |db| db.change(&code, &token, |doc, identity, _| session::lock(doc, identity))).await?))
}

pub async fn join(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store
            .call(move |db| {
                let seat = db.seat_token_of(&token)?;
                db.change(&code, &token, |doc, identity, _| session::join(doc, identity, &seat))
            })
            .await?,
    ))
}

pub async fn moves(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let request = parse_move_request(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("A move needs game, moveCount and cell."))?;
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store
            .call(move |db| db.change(&code, &token, |doc, identity, _| session::play_move(doc, identity, &request, now_ms())))
            .await?,
    ))
}

pub async fn new_game(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(app.store.call(move |db| db.change(&code, &token, |doc, identity, _| session::new_game(doc, identity))).await?))
}

pub async fn seats(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let action = parse_seat_action(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("A seat change needs an action, and a watcher id for give, seat and replace."))?;
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store
            .call(move |db| db.change(&code, &token, |doc, identity, watchers| session::seat(doc, identity, &action, watchers, now_ms())))
            .await?,
    ))
}

pub async fn answer_seat(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let accept = parse_seat_answer(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("An answer needs accept: true or false."))?;
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store
            .call(move |db| {
                db.change(&code, &token, |doc, identity, watchers| session::answer_seat(doc, identity, accept, watchers, now_ms()))
            })
            .await?,
    ))
}

pub async fn chat(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let body = read_json(body, MAX_BODY_BYTES).await?;
    // A text that is not a string fails the length check of the rule, after its seat check, as in TypeScript.
    let text = body.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store
            .call(move |db| {
                let author = crate::ids::person_id(&db.owner_of(&token)?);
                db.change(&code, &token, |doc, identity, watchers| session::chat(doc, identity, &text, now_ms(), Some(&author), watchers))
            })
            .await?,
    ))
}

pub async fn playoff(State(app): State<App>, Path(code): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let request = parse_playoff_request(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("A playoff request is start (preset, seed), join (id), leave (id) or hit (id, index, ms)."))?;
    let code = session_code(&code)?;
    let token = require_player(&headers)?;
    Ok(view(
        app.store.call(move |db| db.change(&code, &token, |doc, identity, _| session::playoff(doc, identity, request, now_ms()))).await?,
    ))
}

//! Reports, the moderation routes of the maintainers, and page faults (server/main.ts).
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::App;
use crate::account::require_person;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Limiter, client_of};
use crate::protocol::{is_github_login, js_safe_integer, parse_client_event, parse_report_request};
use crate::sessions::{MAX_BODY_BYTES, ok_json, read_json, require_player, session_code};
use crate::store::{DeleteTarget, now_ms};

/// Page faults per address: 30 per 10 minutes (EVENTS_PER_10_MINUTES). The message is the same as Node's.
static ALLOW_EVENT: Limiter = Limiter::new(30, 600_000, 10_000, "Too many reports from this address. Try again later.");
const MAX_EVENT_BODY_BYTES: usize = 1024;

/// Reports per address: 20 per 10 minutes (REPORTS_PER_10_MINUTES).
static ALLOW_REPORT: Limiter = Limiter::new(20, 600_000, 10_000, "Too many reports from this address. Try again later.");

pub async fn report(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_REPORT.allow(&client_of(&headers, peer), now_ms())?;
    let token = require_player(&headers)?;
    let request = parse_report_request(&read_json(body, MAX_BODY_BYTES).await?).ok_or_else(|| {
        ApiError::bad_request("A report needs one message id with a code or one person id, a reason, and a note of at most 200 characters.")
    })?;
    let id = app.store.call(move |db| db.report(&token, request)).await?;
    Ok(ok_json(StatusCode::CREATED, &json!({ "id": id })))
}

pub async fn reports(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    app.require_maintainer(&headers)?;
    Ok(ok_json(StatusCode::OK, &app.store.call(|db| db.reports()).await?))
}

pub async fn hide_message(
    State(app): State<App>,
    Path((code, message)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let login = app.require_maintainer(&headers)?;
    let message = js_safe_integer(&message, 1).ok_or_else(|| ApiError::bad_request("A message id is a whole number from 1."))?;
    let code = session_code(&code)?;
    app.store.call(move |db| db.hide_message(&code, message, &login)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "ok": true })))
}

pub async fn clear_name_of(State(app): State<App>, Path(person): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let login = app.require_maintainer(&headers)?;
    let person = require_person(&person)?;
    for token in app.store.call(move |db| db.clear_name_of(&person, &login)).await? {
        app.live.notify_player(&token);
    }
    Ok(ok_json(StatusCode::OK, &json!({ "ok": true })))
}

/// An email request for Delete my data: the same deletion, by a maintainer.
pub async fn delete_person(State(app): State<App>, Path(person): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    app.require_maintainer(&headers)?;
    let person = require_person(&person)?;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.delete_data_of(DeleteTarget::Person(person))).await?))
}

pub async fn delete_account(State(app): State<App>, Path(login): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    app.require_maintainer(&headers)?;
    if !is_github_login(&login) {
        return Err(ApiError::bad_request("A GitHub login has 1 to 39 letters, digits or \"-\"."));
    }
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.delete_data_of(DeleteTarget::Login(login))).await?))
}

pub async fn event(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_EVENT.allow(&client_of(&headers, peer), now_ms())?;
    let event = parse_client_event(&read_json(body, MAX_EVENT_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("An event needs a kind, a message of 1 to 300 characters and a version."))?;
    app.store.call(move |db| db.add_event(event)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "ok": true })))
}

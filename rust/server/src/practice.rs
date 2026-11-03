//! The practice room routes (server/main.ts: POST /api/practice/runs, GET /api/practice/best).
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use tick3d_core::playoff::PresetId;

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Limiter, client_of};
use crate::protocol::{PracticeMode, parse_practice_run};
use crate::sessions::{MAX_BODY_BYTES, ok_json, optional_player, read_json, require_player};
use crate::store::now_ms;

/// Runs per address: 60 per 10 minutes (PRACTICE_RUNS_PER_10_MINUTES).
static ALLOW_PRACTICE_RUN: Limiter = Limiter::new(60, 600_000, 10_000, "Too many practice runs from this address. Try again later.");

pub async fn add_run(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_PRACTICE_RUN.allow(&client_of(&headers, peer), now_ms())?;
    let token = require_player(&headers)?;
    let run = parse_practice_run(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("The run is not one that the practice room can make."))?;
    let stored = app.store.call(move |db| db.add_practice_run(&token, run)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "stored": stored })))
}

#[derive(Deserialize)]
pub struct BoardQuery {
    mode: Option<String>,
    preset: Option<String>,
}

pub async fn best(State(app): State<App>, Query(query): Query<BoardQuery>, headers: HeaderMap) -> ApiResult<Response> {
    let mode = query.mode.as_deref().and_then(PracticeMode::parse);
    let preset = query.preset.as_deref().and_then(PresetId::parse);
    let (Some(mode), Some(preset)) = (mode, preset) else {
        return Err(ApiError::bad_request("A leaderboard needs a mode (targets or echo) and a preset (easy, normal or hard)."));
    };
    let token = optional_player(&headers)?;
    let board = app.store.call(move |db| db.practice_board(mode, preset, token.as_deref())).await?;
    Ok(ok_json(StatusCode::OK, &board))
}

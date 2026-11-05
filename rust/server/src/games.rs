//! Finished games and achievements as players read them (GET /api/games/{id} and the /api/me game routes).
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::protocol::js_number;
use crate::results::game_id;
use crate::sessions::ok_json;

/// A read-only game link. Anybody with the id may read the game, so the answer holds no token.
pub async fn game(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Response> {
    let id = game_id(&id)?;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.game(&id)).await?))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    offset: Option<String>,
}

pub async fn history(State(app): State<App>, Query(query): Query<HistoryQuery>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    let offset = js_number(query.offset.as_deref().unwrap_or("0"))
        .filter(|offset| offset.fract() == 0.0 && *offset >= 0.0)
        .ok_or_else(|| ApiError::bad_request("The offset is not a whole number of games."))?;
    // An offset past i64 holds no games, as any offset past the last game.
    let offset = offset.min(i64::MAX as f64) as i64;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.history(&token, offset)).await?))
}

/// A cross-site form cannot send the X-Player header, so another site cannot clear a history.
pub async fn clear_history(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    let hidden = app.store.call(move |db| db.clear_history(&token)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "hidden": hidden })))
}

pub async fn records(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    let records = app.store.call(move |db| db.records(&token)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "records": records })))
}

pub async fn my_games(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.my_games(&token)).await?))
}

/// Every achievement of the player and its rarity.
pub async fn achievements(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.achievements(&token)).await?))
}

/// "Reset achievements": from now on only new games count. It answers with the achievements after the reset.
pub async fn reset_achievements(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = app.linked_player(&headers).await?;
    let achievements = app
        .store
        .call(move |db| {
            db.reset_achievements(&token)?;
            db.achievements(&token)
        })
        .await?;
    Ok(ok_json(StatusCode::OK, &achievements))
}

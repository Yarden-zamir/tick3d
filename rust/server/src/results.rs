//! Finished games: uploads from the devices and the metrics of online games.
use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::protocol::{GameId, RESULTS_PER_UPLOAD, parse_game_id, parse_metrics};
use crate::sessions::{MAX_BODY_BYTES, ok_json, read_json, require_player};
use crate::store::metric_lists;

/// A result upload carries up to RESULTS_PER_UPLOAD finished games of about 1 kB each (MAX_RESULTS_BODY_BYTES).
const MAX_RESULTS_BODY_BYTES: usize = 256 * 1024;

pub fn game_id(text: &str) -> ApiResult<GameId> {
    parse_game_id(text).ok_or_else(|| ApiError::bad_request("A game id is 8 letters or digits, or a code and a game number."))
}

pub async fn add_results(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let body = read_json(body, MAX_RESULTS_BODY_BYTES).await?;
    let uploads = match body.get("results") {
        Some(Value::Array(uploads)) if uploads.len() <= RESULTS_PER_UPLOAD => uploads.clone(),
        _ => return Err(ApiError::bad_request(format!("An upload needs a results list of at most {RESULTS_PER_UPLOAD}."))),
    };
    let token = require_player(&headers)?;
    let total = uploads.len();
    let (queued, refused) = app.store.call(move |db| Ok(db.add_results(&token, &uploads))).await?;
    // A refused result shows here only as a count and a reason: no token, no game.
    if let Some(first) = refused.first() {
        eprintln!("result upload: refused {} of {total}: {}", refused.len(), first.error);
    }
    let mut stored = 0;
    let mut renamed = BTreeMap::new();
    for upload in queued {
        let outcome = upload.outcome.await.map_err(|_| ApiError::fault("a result outcome was dropped"))?.map_err(ApiError::fault)?;
        if outcome.stored {
            stored += 1;
        }
        // A row from before game links has no public id. The device then keeps the id it has.
        if let Some(public_id) = outcome.public_id
            && Some(&public_id) != upload.asked.as_ref()
        {
            renamed.insert(upload.id, public_id);
        }
    }
    let refused: Vec<Value> = refused.iter().map(|each| json!({ "index": each.index, "error": each.error })).collect();
    Ok(ok_json(StatusCode::OK, &json!({ "stored": stored, "renamed": renamed, "refused": refused })))
}

pub async fn add_metrics(State(app): State<App>, Path(id): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let id = game_id(&id)?;
    let metrics = parse_metrics(metric_lists(), &read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("The metrics are not valid."))?;
    let token = require_player(&headers)?;
    let stored = app.store.call(move |db| db.add_seat_metrics(&id, &token, &metrics)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "stored": stored })))
}

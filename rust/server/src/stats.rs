//! The stats page (server/main.ts: GET /api/stats, GET /api/stats/card/{person} and GET /api/leaderboard). Aggregates only (see
//! store/stats.rs), so the public stats page needs no login.
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::App;
use crate::account::require_person;
use crate::error::{ApiError, ApiResult, no_store};
use crate::protocol::{LEADERBOARD_FILTER_ERROR, STATS_FILTER_ERROR, StatsScope, parse_leaderboard_filter, parse_stats_filter};
use crate::sessions::{ok_json, optional_player, require_player};
use std::sync::Arc;

use crate::store::{everyone_stats, leaderboard_of, scoped_stats};

/// Mine needs the X-Player header: the stats of that player on all linked devices. A person filter reads the header when
/// it is there, so a person who hides their stats still sees them. Everyone comes from a snapshot.
pub async fn stats(State(app): State<App>, RawQuery(query): RawQuery, headers: HeaderMap) -> ApiResult<Response> {
    let filter = parse_stats_filter(query.as_deref()).ok_or_else(|| ApiError::bad_request(STATS_FILTER_ERROR))?;
    if filter.scope == StatsScope::Mine || filter.person.is_some() {
        let token = if filter.scope == StatsScope::Mine { Some(require_player(&headers)?) } else { optional_player(&headers)? };
        let asked = filter.clone();
        let subject = Arc::new(app.store.call(move |db| db.stats_subject(&asked, token.as_deref())).await?);
        let (reading, achieving) = (subject.clone(), subject);
        let (answer, achievements) = tokio::join!(
            app.store.read(move |conn| scoped_stats(conn, &filter, &reading)),
            app.store.call(move |db| db.subject_achievements(&achieving)),
        );
        let mut answer = answer?;
        answer["achievements"] = achievements?;
        return Ok(ok_json(StatusCode::OK, &answer));
    }
    let store = app.store.clone();
    let key = format!("stats {filter:?}");
    let answer = app
        .snapshots
        .get(key, move || {
            let (store, filter) = (store.clone(), filter.clone());
            async move {
                let sessions = store.call(|db| Ok(db.session_count())).await?;
                store.read(move |conn| everyone_stats(conn, &filter, sessions)).await
            }
        })
        .await?;
    Ok(json_bytes(answer))
}

/// The player card of a person view, before the stats of that person. It reads the X-Player header as a person filter does.
pub async fn card(State(app): State<App>, Path(person): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let token = optional_player(&headers)?;
    let person = require_person(&person)?;
    Ok(ok_json(StatusCode::OK, &app.store.call(move |db| db.stats_card(&person, token.as_deref())).await?))
}

/// Names and results of each player, so the stats page can rank them, from a snapshot. It reads the X-Player header when
/// it is there, to mark the caller.
pub async fn leaderboard(State(app): State<App>, RawQuery(query): RawQuery, headers: HeaderMap) -> ApiResult<Response> {
    let filter = parse_leaderboard_filter(query.as_deref()).ok_or_else(|| ApiError::bad_request(LEADERBOARD_FILTER_ERROR))?;
    let token = optional_player(&headers)?;
    let you = match token {
        Some(token) => Some(app.store.call(move |db| db.person(&token)).await?),
        None => None,
    };
    let store = app.store.clone();
    let key = format!("leaderboard {filter:?}");
    let board = app.snapshots.get(key, move || leaderboard_of(store.clone(), filter.clone())).await?;
    // The board is a JSON object without "you": replace its closing brace with the caller's field.
    let open = board.strip_suffix(b"}").ok_or_else(|| ApiError::fault("a leaderboard snapshot is not a JSON object"))?;
    let you = serde_json::to_vec(&you).map_err(ApiError::fault)?;
    Ok(json_bytes(Bytes::from([open, b",\"you\":", &you, b"}"].concat())))
}

/// A JSON answer from ready bytes, with the headers of `ok_json`.
fn json_bytes(body: Bytes) -> Response {
    (StatusCode::OK, no_store(), [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

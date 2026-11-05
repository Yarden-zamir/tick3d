//! The bought copies of the apps (POST /api/copies/nonce and POST /api/copies). A store proof makes or
//! confirms the copy of a device. The checks of the proofs are in play_proof.rs and apple_proof.rs.
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};

use crate::App;
use crate::apple_proof::ApplePurchase;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Limiter, client_of};
use crate::protocol::parse_person_id;
use crate::sessions::{ok_json, read_json, require_player};
use crate::store::now_ms;

/// APP_OPENS_PER_HOUR in contract/api-docs.ts, for app opens and for nonces.
static ALLOW_APP_OPEN: Limiter = Limiter::new(60, 3_600_000, 10_000, "Too many app reports from this address. Try again later.");
static ALLOW_PROOF_NONCE: Limiter = Limiter::new(60, 3_600_000, 10_000, "Too many purchase checks from this address.");
/// A proof is at most 32 KiB of text, inside a body of at most 40 KiB.
const MAX_PROOF: usize = 32_768;
const MAX_BODY_BYTES: usize = 40 * 1024;

/// The store of the app that opened, with its signed proof (AppOpen in src/copies.ts).
enum AppOpen {
    Play { proof: String },
    Apple { proof: String, device: String },
}

/// parseAppleDeviceId: a lower-case UUID.
fn is_device_id(text: &str) -> bool {
    text.len() == 36
        && text
            .char_indices()
            .all(|(index, char)| if [8, 13, 18, 23].contains(&index) { char == '-' } else { matches!(char, '0'..='9' | 'a'..='f') })
}

/// parseAppOpen: the proof, the inviter or null in "by", and the store. A Play open has no device.
fn parse_app_open(value: &Value) -> Option<(Option<String>, AppOpen)> {
    let proof = value["proof"].as_str().filter(|proof| !proof.is_empty() && proof.encode_utf16().count() <= MAX_PROOF)?.to_owned();
    let by = match &value["by"] {
        Value::Null if value.get("by").is_some() => None,
        Value::String(by) => Some(parse_person_id(by)?),
        _ => return None,
    };
    let open = match (value["store"].as_str(), value.get("device")) {
        (Some("play"), None) => AppOpen::Play { proof },
        (Some("apple"), Some(Value::String(device))) if is_device_id(device) => AppOpen::Apple { proof, device: device.clone() },
        _ => return None,
    };
    Some((by, open))
}

/// A cross-site form cannot send the X-Player header, so another site cannot ask for a nonce of a player.
pub async fn nonce(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> ApiResult<Response> {
    ALLOW_PROOF_NONCE.allow(&client_of(&headers, peer), now_ms())?;
    let token = require_player(&headers)?;
    Ok(ok_json(StatusCode::OK, &json!({ "nonce": app.play.nonce(&token)? })))
}

pub async fn report(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_APP_OPEN.allow(&client_of(&headers, peer), now_ms())?;
    let token = require_player(&headers)?;
    let (by, open) = parse_app_open(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("An app open report needs the person id of the inviter, or null, in \"by\"."))?;
    // The checks call Google or Apple, so they run off the async threads.
    let checker = app.clone();
    let player = token.clone();
    let purchase: Result<Option<ApplePurchase>, ()> = tokio::task::spawn_blocking(move || match open {
        AppOpen::Play { proof } => checker.play.verify(&proof, &player).map(|licensed| if licensed { Ok(None) } else { Err(()) }),
        AppOpen::Apple { proof, device } => {
            let apple = checker
                .apple
                .as_ref()
                .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Apple purchase checks are not configured."))?;
            apple.verify(&proof, &device, now_ms()).map(|purchase| Ok(Some(purchase)))
        }
    })
    .await
    .map_err(ApiError::fault)??;
    // A login cookie links this browser first, so the answer and the owner at the first open name the account.
    let token = app.linked_player(&headers).await?;
    let has_copy = match purchase {
        Err(()) => app.store.call(move |db| db.revoke_play_copy(&token)).await?,
        Ok(apple) => app.store.call(move |db| db.report_app_open(&token, by, apple)).await?,
    };
    Ok(ok_json(StatusCode::OK, &json!({ "hasCopy": has_copy })))
}

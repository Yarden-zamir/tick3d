//! The Google Play promo codes of the closed test (src/share/codes.ts) and their routes.
//! KitSHn fills TESTER_CODES from the GitHub secret KITSHN_TESTER_CODES. The repository is public, so codes never go in git.
use std::collections::HashSet;
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Limiter, client_of};
use crate::protocol::{TESTER_NAME_MAX_LENGTH, js_safe_integer, parse_claim_request, parse_tester_name};
use crate::sessions::{MAX_BODY_BYTES, ok_json, read_json, require_player};
use crate::store::{hint_of, now_ms};

const CODE_MIN_LENGTH: usize = 10;
const CODE_MAX_LENGTH: usize = 30;
/// The KitSHn environment of production.
const PRODUCTION_ENVIRONMENT: &str = "prod";

/// Claims per address: 5 per hour (TESTER_CLAIMS_PER_HOUR).
static ALLOW_TESTER_CLAIM: Limiter = Limiter::new(5, 3_600_000, 10_000, "Too many code claims from this address. Try again later.");

/// One entry of TESTER_CODES: a free code, or a code that `name` holds already.
#[derive(Debug, PartialEq, Eq)]
pub struct TesterCodeEntry {
    pub code: String,
    pub name: Option<String>,
}

fn is_tester_code(code: &str) -> bool {
    (CODE_MIN_LENGTH..=CODE_MAX_LENGTH).contains(&code.len()) && code.chars().all(|char| char.is_ascii_uppercase() || char.is_ascii_digit())
}

/// parseTesterCodeEntries: entries split by commas or new lines. An entry is `CODE` (free) or `CODE=Name` (given out
/// already, to Name). A bad entry is an error, so a typo in the secret stops the start.
pub fn parse_tester_code_entries(text: &str) -> Result<Vec<TesterCodeEntry>, String> {
    let mut seen = HashSet::new();
    text.split(['\n', ','])
        .map(crate::protocol::js_trim)
        .filter(|entry| !entry.is_empty())
        .enumerate()
        .map(|(index, entry)| {
            let number = index + 1;
            let (code, name) = match entry.split_once('=') {
                None => (entry, None),
                Some((code, name)) => (crate::protocol::js_trim(code), Some(name)),
            };
            if !is_tester_code(code) {
                return Err(format!(
                    "TESTER_CODES entry {number}: a code has {CODE_MIN_LENGTH} to {CODE_MAX_LENGTH} characters from A-Z and 0-9"
                ));
            }
            if !seen.insert(code) {
                return Err(format!("TESTER_CODES entry {number}: the code {}… comes twice", hint_of(code)));
            }
            let name = match name {
                None => None,
                Some(name) => Some(
                    parse_tester_name(name)
                        .ok_or_else(|| format!("TESTER_CODES entry {number}: the name after \"=\" is not a valid name"))?,
                ),
            };
            Ok(TesterCodeEntry { code: code.to_owned(), name })
        })
        .collect()
}

/// The codes to add at start. Production and a local server (no KITSHN_ENVIRONMENT) read TESTER_CODES.
/// A pull request preview reads none, so a preview database never holds a real code.
pub fn tester_codes_from_env() -> Result<Vec<TesterCodeEntry>, String> {
    let environment = std::env::var("KITSHN_ENVIRONMENT").unwrap_or_default();
    if !environment.is_empty() && environment != PRODUCTION_ENVIRONMENT {
        return Ok(Vec::new());
    }
    parse_tester_code_entries(&std::env::var("TESTER_CODES").unwrap_or_default())
}

pub async fn codes(State(app): State<App>) -> ApiResult<Response> {
    Ok(ok_json(StatusCode::OK, &app.store.call(|db| db.tester_codes()).await?))
}

/// A cross-site form cannot send the X-Player header, so another site cannot claim a code.
pub async fn claim(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(code_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    ALLOW_TESTER_CLAIM.allow(&client_of(&headers, peer), now_ms())?;
    let token = require_player(&headers)?;
    // A text that `Number` reads but that is not the plain number, such as "01" or "1.0", is refused too.
    let id = js_safe_integer(&code_id, 1)
        .filter(|id| id.to_string() == code_id)
        .ok_or_else(|| ApiError::bad_request("A code id is a whole number from 1."))?;
    let claim = parse_claim_request(&read_json(body, MAX_BODY_BYTES).await?).ok_or_else(|| {
        ApiError::bad_request(format!(
            "A claim needs a valid email, a name of 1 to {TESTER_NAME_MAX_LENGTH} letters, digits, spaces or - _ . ', and in \"by\" a person id or nothing."
        ))
    })?;
    let code = app.store.call(move |db| db.claim_tester_code(id, claim, &token)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "code": code })))
}

pub async fn claims(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    app.require_maintainer(&headers)?;
    Ok(ok_json(StatusCode::OK, &app.store.call(|db| db.tester_claims()).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_split_on_commas_and_lines() {
        let entries = parse_tester_code_entries(" ABCDEFGHIJ1 ,\nABCDEFGHIJ2=Ann  Lee\n\n").expect("valid entries");
        assert_eq!(
            entries,
            [
                TesterCodeEntry { code: "ABCDEFGHIJ1".into(), name: None },
                TesterCodeEntry { code: "ABCDEFGHIJ2".into(), name: Some("Ann Lee".into()) },
            ]
        );
        assert!(parse_tester_code_entries("").expect("no entries").is_empty());
    }

    #[test]
    fn bad_entries_stop_the_start() {
        assert!(parse_tester_code_entries("abcdefghij1").is_err());
        assert!(parse_tester_code_entries("ABCDEFGHIJ1,ABCDEFGHIJ1").is_err());
        assert!(parse_tester_code_entries("ABCDEFGHIJ1=").is_err());
    }
}

//! Google Play purchase proofs: a classic Play Integrity request with a server nonce.
//! The access token of the service account stays in memory until it nearly expires, so a check costs one Google call,
//! not two. A restart drops the outstanding nonces, not the copies.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};

use crate::error::{ApiError, ApiResult};
use crate::store::now_ms;

/// A nonce answers for 5 minutes.
const FRESH_MS: i64 = 5 * 60_000;
/// The outstanding nonces at most. Limit: one API process owns them. Revisit before adding another API process.
const MAX_PENDING: usize = 10_000;
/// The package of the Android app (android/twa-manifest.json).
pub const PACKAGE_ID: &str = "com.yardenzamir.tick3d";
const SCOPE: &str = "https://www.googleapis.com/auth/playintegrity";

fn refusal(status: StatusCode, message: &str) -> ApiError {
    ApiError::new(status, message)
}

/// The service account of PLAY_SERVICE_ACCOUNT_JSON.
struct Account {
    email: String,
    key: RsaKeyPair,
    token_uri: String,
    /// The access token and the time when it expires.
    token: Mutex<Option<(String, i64)>>,
}

pub struct PlayProof {
    account: Option<Account>,
    pending: Mutex<HashMap<String, (i64, String)>>,
}

impl PlayProof {
    /// None in the account when PLAY_SERVICE_ACCOUNT_JSON is not set: then each check answers 503. A bad value stops the start.
    pub fn from_env() -> Result<PlayProof, String> {
        let account = match std::env::var("PLAY_SERVICE_ACCOUNT_JSON").ok().filter(|text| !text.is_empty()) {
            None => None,
            Some(text) => Some(Account::parse(&text)?),
        };
        Ok(PlayProof { account, pending: Mutex::default() })
    }

    pub fn nonce(&self, player: &str) -> ApiResult<String> {
        let now = now_ms();
        let mut pending = self.pending.lock().expect("the nonce map is not poisoned");
        pending.retain(|_, (issued, _)| now - *issued < FRESH_MS);
        if pending.len() >= MAX_PENDING {
            return Err(refusal(StatusCode::SERVICE_UNAVAILABLE, "Too many purchase checks. Try again later."));
        }
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        let nonce = URL_SAFE_NO_PAD.encode(bytes);
        pending.insert(nonce.clone(), (now, player.to_owned()));
        Ok(nonce)
    }

    /// True for a licensed copy, false for an unlicensed one. It blocks on the network: call it from `spawn_blocking`.
    pub fn verify(&self, token: &str, player: &str) -> ApiResult<bool> {
        let account =
            self.account.as_ref().ok_or_else(|| refusal(StatusCode::SERVICE_UNAVAILABLE, "Purchase checks are not configured."))?;
        let decoded = account.decode(token)?;
        self.verdict_of(&decoded, player, now_ms())
    }

    /// The verdict of a decoded integrity token for `player` at `now`. The nonce must be ours, fresh, unused and for this player.
    fn verdict_of(&self, decoded: &Value, player: &str, now: i64) -> ApiResult<bool> {
        let payload = &decoded["tokenPayloadExternal"];
        let (request, app, licensing) =
            (&payload["requestDetails"], &payload["appIntegrity"], &payload["accountDetails"]["appLicensingVerdict"]);
        if !request.is_object() || !app.is_object() || !payload["accountDetails"].is_object() {
            return Err(refusal(StatusCode::FORBIDDEN, "Google Play did not prove this purchase."));
        }
        let nonce = request["nonce"].as_str().unwrap_or("");
        let timestamp =
            request["timestampMillis"].as_str().and_then(|text| text.parse::<i64>().ok()).filter(|at| *at >= 0 && *at < (1 << 53));
        let mut pending = self.pending.lock().expect("the nonce map is not poisoned");
        let valid = pending.get(nonce).is_some_and(|(issued, owner)| {
            owner == player
                && now - issued < FRESH_MS
                && timestamp.is_some_and(|at| at >= issued - 30_000 && at <= now + 30_000)
                && request["requestPackageName"] == PACKAGE_ID
                && app["packageName"] == PACKAGE_ID
                && app["appRecognitionVerdict"] == "PLAY_RECOGNIZED"
                && licensing.is_string()
        });
        if !valid {
            return Err(refusal(StatusCode::FORBIDDEN, "Google Play did not prove this purchase. Open the app again."));
        }
        // The lock is held from the lookup to the removal, so two submissions cannot use one nonce.
        pending.remove(nonce);
        // UNEVALUATED means that Google could not decide, so only UNLICENSED is a negative verdict.
        match licensing.as_str() {
            Some("LICENSED") => Ok(true),
            Some("UNLICENSED") => Ok(false),
            _ => Err(refusal(StatusCode::FORBIDDEN, "Google Play could not check the purchase. Open the app again later.")),
        }
    }
}

impl Account {
    fn parse(text: &str) -> Result<Account, String> {
        // The parse error quotes part of the secret, so the start crash must not carry it into the log.
        let value: Value = serde_json::from_str(text).map_err(|_| "PLAY_SERVICE_ACCOUNT_JSON is not valid JSON".to_owned())?;
        let (Some(email), Some(pem)) = (value["client_email"].as_str(), value["private_key"].as_str()) else {
            return Err("PLAY_SERVICE_ACCOUNT_JSON needs client_email and private_key".into());
        };
        let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
        let der = STANDARD.decode(body.trim()).map_err(|_| "PLAY_SERVICE_ACCOUNT_JSON has a private_key that is not PEM".to_owned())?;
        let key = RsaKeyPair::from_pkcs8(&der)
            .map_err(|_| "PLAY_SERVICE_ACCOUNT_JSON has a private_key that is not an RSA PKCS#8 key".to_owned())?;
        let token_uri = value["token_uri"].as_str().unwrap_or("https://oauth2.googleapis.com/token").to_owned();
        Ok(Account { email: email.to_owned(), key, token_uri, token: Mutex::default() })
    }

    fn unavailable() -> ApiError {
        refusal(StatusCode::SERVICE_UNAVAILABLE, "Google Play could not check the purchase. Open the app again later.")
    }

    /// The access token of the service account, through the JWT bearer grant (RFC 7523).
    fn access_token(&self) -> ApiResult<String> {
        let now = now_ms();
        if let Some((token, expires)) = self.token.lock().expect("the token is not poisoned").as_ref()
            && now < *expires
        {
            return Ok(token.clone());
        }
        let seconds = now / 1000;
        let encode = |value: Value| URL_SAFE_NO_PAD.encode(value.to_string());
        let unsigned = format!(
            "{}.{}",
            encode(json!({ "alg": "RS256", "typ": "JWT" })),
            encode(json!({ "iss": self.email, "scope": SCOPE, "aud": self.token_uri, "iat": seconds, "exp": seconds + 3600 }))
        );
        let mut signature = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), unsigned.as_bytes(), &mut signature)
            .map_err(|_| ApiError::fault("the Play JWT does not sign"))?;
        let assertion = format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(signature));
        let answer: Value = ureq::post(&self.token_uri)
            .config()
            .timeout_global(Some(Duration::from_secs(15)))
            .build()
            .send_form([("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())])
            .map_err(|error| {
                eprintln!("play token: {error}");
                Account::unavailable()
            })?
            .body_mut()
            .read_json()
            .map_err(|_| Account::unavailable())?;
        let token = answer["access_token"].as_str().ok_or_else(Account::unavailable)?.to_owned();
        // A minute early, so a token never expires on its way to Google.
        let expires = now + answer["expires_in"].as_i64().unwrap_or(3600) * 1000 - 60_000;
        *self.token.lock().expect("the token is not poisoned") = Some((token.clone(), expires));
        Ok(token)
    }

    fn decode(&self, token: &str) -> ApiResult<Value> {
        let access = self.access_token()?;
        let url = format!("https://playintegrity.googleapis.com/v1/{PACKAGE_ID}:decodeIntegrityToken");
        ureq::post(&url)
            .config()
            .timeout_global(Some(Duration::from_secs(15)))
            .build()
            .header("Authorization", &format!("Bearer {access}"))
            .send_json(json!({ "integrity_token": token }))
            .map_err(|error| {
                eprintln!("play decode: {error}");
                Account::unavailable()
            })?
            .body_mut()
            .read_json()
            .map_err(|_| Account::unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(nonce: &str, timestamp: i64, package: &str, verdict: &str) -> Value {
        json!({ "tokenPayloadExternal": {
            "requestDetails": { "nonce": nonce, "timestampMillis": timestamp.to_string(), "requestPackageName": package },
            "appIntegrity": { "packageName": package, "appRecognitionVerdict": "PLAY_RECOGNIZED" },
            "accountDetails": { "appLicensingVerdict": verdict },
        } })
    }

    fn status(result: ApiResult<bool>) -> Result<bool, StatusCode> {
        result.map_err(|error| match error {
            ApiError::Refusal { status, .. } => status,
            other => panic!("a fault: {other:?}"),
        })
    }

    #[test]
    fn binds_a_nonce_to_its_player_and_uses_it_once() {
        let proof = PlayProof { account: None, pending: Mutex::default() };
        let now = now_ms();
        let nonce = proof.nonce("alice").expect("a nonce");
        assert_eq!(
            status(proof.verdict_of(&decoded(&nonce, now, PACKAGE_ID, "LICENSED"), "bob", now)),
            Err(StatusCode::FORBIDDEN),
            "another player"
        );
        assert_eq!(
            status(proof.verdict_of(&decoded(&nonce, now, "com.other", "LICENSED"), "alice", now)),
            Err(StatusCode::FORBIDDEN),
            "another app"
        );
        assert_eq!(
            status(proof.verdict_of(&decoded(&nonce, now - 60_000, PACKAGE_ID, "LICENSED"), "alice", now)),
            Err(StatusCode::FORBIDDEN),
            "signed before the nonce"
        );
        assert_eq!(
            status(proof.verdict_of(&decoded(&nonce, now, PACKAGE_ID, "LICENSED"), "alice", now + FRESH_MS)),
            Err(StatusCode::FORBIDDEN),
            "a stale nonce"
        );
        assert_eq!(status(proof.verdict_of(&decoded(&nonce, now, PACKAGE_ID, "LICENSED"), "alice", now)), Ok(true));
        assert_eq!(
            status(proof.verdict_of(&decoded(&nonce, now, PACKAGE_ID, "LICENSED"), "alice", now)),
            Err(StatusCode::FORBIDDEN),
            "a used nonce"
        );
        assert_eq!(
            status(proof.verdict_of(&decoded("made-up", now, PACKAGE_ID, "LICENSED"), "alice", now)),
            Err(StatusCode::FORBIDDEN),
            "not our nonce"
        );
    }

    #[test]
    fn reads_the_licensing_verdict() {
        let proof = PlayProof { account: None, pending: Mutex::default() };
        let now = now_ms();
        let verdict = |verdict: &str| {
            let nonce = proof.nonce("alice").expect("a nonce");
            status(proof.verdict_of(&decoded(&nonce, now, PACKAGE_ID, verdict), "alice", now))
        };
        assert_eq!(verdict("UNLICENSED"), Ok(false));
        assert_eq!(verdict("UNEVALUATED"), Err(StatusCode::FORBIDDEN), "Google could not decide: no verdict either way");
        assert_eq!(status(proof.verify("token", "alice")), Err(StatusCode::SERVICE_UNAVAILABLE), "no service account");
    }
}

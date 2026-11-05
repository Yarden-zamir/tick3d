//! Where the apps stand in the stores (GET /api/stores). The /share page and the iOS app switch to their launch
//! versions once the Android app is live on Google Play.
//! The server reads the public Play listing of the app: Google answers 404 while the app is only in a closed test, and
//! 200 once a production release exists. It needs no credentials and no step in the release workflow.
//! Limit: an open test makes the listing public too, and the repository has no open test. Revisit this if an open test
//! starts, or if Google answers a hidden listing with something other than 404.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;

use crate::App;
use crate::play_proof::PACKAGE_ID;
use crate::sessions::ok_json;

/// The server checks the listing at start, then this often, until the app is live.
const CHECK_EVERY: Duration = Duration::from_secs(3600);
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PlayStage {
    /// Only testers get the app (the closed test).
    Testing,
    /// Everyone gets the app from Google Play.
    Live,
}

/// Once live, the stage stays live while the process runs, so a later error or a short outage at Google cannot turn
/// the pages back.
#[derive(Default)]
pub struct Stores {
    play_live: AtomicBool,
}

impl Stores {
    pub fn play(&self) -> PlayStage {
        if self.play_live.load(Ordering::Relaxed) { PlayStage::Live } else { PlayStage::Testing }
    }
}

/// The stage that one answer of the listing shows, or None for an answer that tells nothing (an error, a rate limit).
fn stage_of(status: u16) -> Option<PlayStage> {
    match status {
        200 => Some(PlayStage::Live),
        404 => Some(PlayStage::Testing),
        _ => None,
    }
}

/// Checks the Play listing at start, then every CHECK_EVERY, until the app is live. A LAN host does not call it.
pub async fn watch(app: App) {
    let url = format!("https://play.google.com/store/apps/details?id={PACKAGE_ID}&hl=en");
    let agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(TIMEOUT)).build().new_agent();
    let mut interval = tokio::time::interval(CHECK_EVERY);
    while app.stores.play() == PlayStage::Testing {
        interval.tick().await;
        let (agent, url) = (agent.clone(), url.clone());
        let answer = tokio::task::spawn_blocking(move || {
            agent.get(&url).header("user-agent", "tick3d").call().map(|response| response.status().as_u16())
        })
        .await;
        match answer {
            Ok(Ok(status)) => match stage_of(status) {
                Some(PlayStage::Live) => {
                    app.stores.play_live.store(true, Ordering::Relaxed);
                    println!("the Play listing is public: the app is live on Google Play");
                }
                Some(PlayStage::Testing) => {}
                None => eprintln!("the Play listing answered {status}"),
            },
            Ok(Err(error)) => eprintln!("the Play listing check failed: {error}"),
            Err(error) => eprintln!("the Play listing check stopped: {error}"),
        }
    }
}

#[derive(Serialize)]
struct StoresAnswer {
    play: PlayStage,
}

pub async fn stores(State(app): State<App>) -> Response {
    ok_json(StatusCode::OK, &StoresAnswer { play: app.stores.play() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_public_or_a_hidden_listing_changes_the_stage() {
        assert_eq!(stage_of(200), Some(PlayStage::Live));
        assert_eq!(stage_of(404), Some(PlayStage::Testing));
        for status in [301, 403, 429, 500, 503] {
            assert_eq!(stage_of(status), None, "{status}");
        }
    }

    #[test]
    fn the_stage_is_a_lower_case_word() {
        assert_eq!(serde_json::to_string(&StoresAnswer { play: PlayStage::Testing }).unwrap(), r#"{"play":"testing"}"#);
        assert_eq!(serde_json::to_string(&StoresAnswer { play: PlayStage::Live }).unwrap(), r#"{"play":"live"}"#);
    }
}

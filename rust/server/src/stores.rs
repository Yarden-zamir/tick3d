//! Where the apps stand in the stores (GET /api/stores). The /share page, "Get the app" and the iOS app switch to their
//! launch versions once an app is live in its store.
//! The server reads the public listings of the apps. It needs no credentials and no step in the release workflow.
//! - Google Play: the listing page answers 404 while the app is only in a closed test, and 200 once a production
//!   release exists. Limit: an open test makes the listing public too, and the repository has no open test. Revisit
//!   this if an open test starts, or if Google answers a hidden listing with something other than 404.
//! - App Store: the iTunes lookup of the app id (APPLE_APP_ID) lists the app once it is on sale, and lists nothing
//!   while it is only on TestFlight. Without APPLE_APP_ID, the server has no Apple stage.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use serde_json::Value;

use crate::App;
use crate::play_proof::PACKAGE_ID;
use crate::sessions::ok_json;

/// The server checks the listings at start, then this often, until each app is live.
const CHECK_EVERY: Duration = Duration::from_secs(3600);
/// After an answer that tells nothing (an error, a time-out), the next check comes sooner.
const RETRY_AFTER: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Only testers get the app (the Play closed test, or TestFlight).
    Testing,
    /// Everyone gets the app from the store.
    Live,
}

/// A store listing that the server watches.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Listing {
    Play,
    AppStore,
}

impl Listing {
    /// The mark in the migrations table of an app that is live in this store (Db::listing_live).
    pub fn mark(self) -> &'static str {
        match self {
            Listing::Play => "play-listing-live",
            Listing::AppStore => "app-store-listing-live",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Listing::Play => "Play",
            Listing::AppStore => "App Store",
        }
    }
}

struct AppStore {
    app_id: u64,
    live: AtomicBool,
}

/// Once live, a stage stays live: the database keeps it (Db::mark_listing_live), so a restart, a later error or a
/// short outage at the store cannot turn the pages back.
#[derive(Default)]
pub struct Stores {
    play_live: AtomicBool,
    /// None without APPLE_APP_ID.
    app_store: Option<AppStore>,
}

impl Stores {
    pub fn new(apple_app_id: Option<u64>) -> Stores {
        Stores {
            play_live: AtomicBool::new(false),
            app_store: apple_app_id.map(|app_id| AppStore { app_id, live: AtomicBool::new(false) }),
        }
    }

    fn live_flag(&self, listing: Listing) -> Option<&AtomicBool> {
        match listing {
            Listing::Play => Some(&self.play_live),
            Listing::AppStore => self.app_store.as_ref().map(|store| &store.live),
        }
    }

    /// The stage in one store, or None for a store that this server does not watch.
    pub fn stage(&self, listing: Listing) -> Option<Stage> {
        self.live_flag(listing).map(|live| if live.load(Ordering::Relaxed) { Stage::Live } else { Stage::Testing })
    }

    fn set_live(&self, listing: Listing) {
        if let Some(live) = self.live_flag(listing) {
            live.store(true, Ordering::Relaxed);
        }
    }

    /// The listings to watch, each with the address that the server reads.
    fn listings(&self) -> Vec<(Listing, String)> {
        let mut listings = vec![(Listing::Play, format!("https://play.google.com/store/apps/details?id={PACKAGE_ID}&hl=en"))];
        if let Some(store) = &self.app_store {
            // Limit: the lookup reads the US store. Revisit this if the app goes on sale outside the US first.
            listings.push((Listing::AppStore, format!("https://itunes.apple.com/lookup?id={}&country=us", store.app_id)));
        }
        listings
    }
}

/// The stage that one answer of the Play listing shows, or None for an answer that tells nothing (an error, a rate limit).
fn play_stage_of(status: u16) -> Option<Stage> {
    match status {
        200 => Some(Stage::Live),
        404 => Some(Stage::Testing),
        _ => None,
    }
}

/// The stage that one answer of the iTunes lookup shows, or None for an answer that tells nothing. The lookup asks
/// for one app id, so a result is that app.
fn app_store_stage_of(status: u16, body: &Value) -> Option<Stage> {
    if status != 200 {
        return None;
    }
    let results = body["results"].as_array()?;
    Some(if results.is_empty() { Stage::Testing } else { Stage::Live })
}

/// Reads one listing. It blocks: call it from `spawn_blocking`.
fn check(agent: &ureq::Agent, listing: Listing, url: &str) -> Result<Option<Stage>, String> {
    let mut response = agent.get(url).header("user-agent", "tick3d").call().map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    match listing {
        Listing::Play => Ok(play_stage_of(status)),
        Listing::AppStore => {
            let body: Value = if status == 200 { response.body_mut().read_json().map_err(|error| error.to_string())? } else { Value::Null };
            Ok(app_store_stage_of(status, &body))
        }
    }
}

/// Reads the stages that the database keeps, then checks each listing at start and every CHECK_EVERY until its app is
/// live. A LAN host does not call it.
pub async fn watch(app: App) {
    let listings = app.stores.listings();
    for &(listing, _) in &listings {
        match app.store.call(move |db| db.listing_live(listing)).await {
            Ok(true) => app.stores.set_live(listing),
            Ok(false) => {}
            Err(error) => eprintln!("the stored {} stage cannot be read: {error:?}", listing.name()),
        }
    }
    let agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(TIMEOUT)).build().new_agent();
    let mut wait = Duration::ZERO;
    loop {
        let pending: Vec<(Listing, String)> =
            listings.iter().filter(|(listing, _)| app.stores.stage(*listing) == Some(Stage::Testing)).cloned().collect();
        if pending.is_empty() {
            return;
        }
        tokio::time::sleep(wait).await;
        wait = CHECK_EVERY;
        for (listing, url) in pending {
            let agent = agent.clone();
            let answer = tokio::task::spawn_blocking(move || check(&agent, listing, &url)).await;
            match answer {
                Ok(Ok(Some(Stage::Live))) => {
                    app.stores.set_live(listing);
                    println!("the {} listing is public: the app is live", listing.name());
                    // The mark keeps the stage across restarts, so the check of this listing ends only once it is stored.
                    while let Err(error) = app.store.call(move |db| db.mark_listing_live(listing)).await {
                        eprintln!("the {} stage cannot be stored, it tries again: {error:?}", listing.name());
                        tokio::time::sleep(RETRY_AFTER).await;
                    }
                }
                Ok(Ok(Some(Stage::Testing))) => {}
                Ok(Ok(None)) => {
                    eprintln!("the {} listing gave no stage", listing.name());
                    wait = RETRY_AFTER;
                }
                Ok(Err(error)) => {
                    eprintln!("the {} listing check failed: {error}", listing.name());
                    wait = RETRY_AFTER;
                }
                Err(error) => {
                    eprintln!("the {} listing check stopped: {error}", listing.name());
                    wait = RETRY_AFTER;
                }
            }
        }
    }
}

#[derive(Serialize)]
struct StoresAnswer {
    play: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    apple: Option<Stage>,
}

impl StoresAnswer {
    fn of(stores: &Stores) -> StoresAnswer {
        StoresAnswer { play: stores.stage(Listing::Play).unwrap_or(Stage::Testing), apple: stores.stage(Listing::AppStore) }
    }
}

pub async fn stores(State(app): State<App>) -> Response {
    ok_json(StatusCode::OK, &StoresAnswer::of(&app.stores))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_public_or_a_hidden_play_listing_changes_the_stage() {
        assert_eq!(play_stage_of(200), Some(Stage::Live));
        assert_eq!(play_stage_of(404), Some(Stage::Testing));
        for status in [301, 403, 429, 500, 503] {
            assert_eq!(play_stage_of(status), None, "{status}");
        }
    }

    #[test]
    fn only_a_lookup_with_or_without_the_app_changes_the_app_store_stage() {
        let live = json!({ "resultCount": 1, "results": [{ "trackId": 6821623182u64, "bundleId": "com.yardenzamir.tick3d" }] });
        assert_eq!(app_store_stage_of(200, &live), Some(Stage::Live));
        assert_eq!(app_store_stage_of(200, &json!({ "resultCount": 0, "results": [] })), Some(Stage::Testing));
        assert_eq!(app_store_stage_of(200, &json!({ "errorMessage": "Invalid value(s) for key(s): [id]" })), None);
        assert_eq!(app_store_stage_of(503, &Value::Null), None);
    }

    /// The marks stay in the database, so the next start reads an app as live before it asks the store.
    #[tokio::test]
    async fn the_database_keeps_a_live_app_per_store() {
        let dir = std::env::temp_dir().join(format!("tick3d-stores-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.duckdb");
        let _ = std::fs::remove_file(&path);
        let live = crate::live::Live::new();
        let store = crate::store::Store::open(path.to_str().unwrap(), live.clone()).unwrap();
        live.set_store(store.clone());
        assert!(!store.call(|db| db.listing_live(Listing::Play)).await.unwrap());
        store.call(|db| db.mark_listing_live(Listing::Play)).await.unwrap();
        store.call(|db| db.mark_listing_live(Listing::Play)).await.unwrap();
        assert!(store.call(|db| db.listing_live(Listing::Play)).await.unwrap());
        assert!(!store.call(|db| db.listing_live(Listing::AppStore)).await.unwrap());
        store.call(|db| db.mark_listing_live(Listing::AppStore)).await.unwrap();
        assert!(store.call(|db| db.listing_live(Listing::AppStore)).await.unwrap());
    }

    #[test]
    fn the_answer_has_an_apple_stage_only_with_an_app_id() {
        let json = |stores: &Stores| serde_json::to_string(&StoresAnswer::of(stores)).unwrap();
        assert_eq!(json(&Stores::new(None)), r#"{"play":"testing"}"#);
        let stores = Stores::new(Some(6821623182));
        assert_eq!(json(&stores), r#"{"play":"testing","apple":"testing"}"#);
        stores.set_live(Listing::Play);
        stores.set_live(Listing::AppStore);
        assert_eq!(json(&stores), r#"{"play":"live","apple":"live"}"#);
        assert_eq!(stores.listings().len(), 2);
        assert_eq!(Stores::new(None).listings().len(), 1);
    }
}

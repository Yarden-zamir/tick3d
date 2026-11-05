//! The last answer of each Everyone query, by kind and filter. The filters have a few dozen
//! combinations, so the map stays small. A request gets the last answer at once. An answer older than its time to live
//! starts a refresh in the background, and the next request gets the new answer. The time to live grows with the cost of
//! a refresh, so a slow refresh does not keep the reader busy. Only the first request of a filter after a start waits.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use serde_json::Value;

use crate::error::ApiResult;
use crate::store::now_ms;

/// STATS_CACHE_MS in contract/api-docs.ts: the shortest time to live of an answer.
const STATS_CACHE_MS: i64 = 60_000;
/// The time to live of an answer is at least this many times the cost of its last refresh.
const SNAPSHOT_COST_FACTOR: i64 = 10;

/// The answer as JSON bytes: a request sends them as they are, with no copy and no serialization.
struct Answer {
    value: Bytes,
    at: i64,
    ttl: i64,
}

#[derive(Default)]
struct Entry {
    /// Held during a refresh, so one refresh of a key runs at a time.
    refresh: tokio::sync::Mutex<()>,
    answer: Mutex<Option<Answer>>,
}

#[derive(Default)]
pub struct Snapshots {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

impl Snapshots {
    pub async fn get<F, Fut>(&self, key: String, compute: F) -> ApiResult<Bytes>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ApiResult<Value>> + Send,
    {
        let entry = self.entries.lock().expect("the snapshot map is not poisoned").entry(key.clone()).or_default().clone();
        let known = entry
            .answer
            .lock()
            .expect("a snapshot is not poisoned")
            .as_ref()
            .map(|answer| (answer.value.clone(), now_ms() - answer.at >= answer.ttl));
        if let Some((value, stale)) = known {
            if stale {
                tokio::spawn(async move {
                    // A refresh that already runs brings the new answer.
                    let Ok(_running) = entry.refresh.try_lock() else { return };
                    if let Err(error) = refresh(&entry, &compute).await {
                        eprintln!("snapshot {key}: {error:?}");
                    }
                });
            }
            return Ok(value);
        }
        let _running = entry.refresh.lock().await;
        // Another request can have filled it while this one waited.
        if let Some(answer) = entry.answer.lock().expect("a snapshot is not poisoned").as_ref() {
            return Ok(answer.value.clone());
        }
        refresh(&entry, &compute).await
    }
}

async fn refresh<F, Fut>(entry: &Entry, compute: &F) -> ApiResult<Bytes>
where
    F: Fn() -> Fut,
    Fut: Future<Output = ApiResult<Value>>,
{
    let began = now_ms();
    let value = Bytes::from(serde_json::to_vec(&compute().await?).map_err(crate::error::ApiError::fault)?);
    let ttl = STATS_CACHE_MS.max(SNAPSHOT_COST_FACTOR * (now_ms() - began));
    *entry.answer.lock().expect("a snapshot is not poisoned") = Some(Answer { value: value.clone(), at: now_ms(), ttl });
    Ok(value)
}

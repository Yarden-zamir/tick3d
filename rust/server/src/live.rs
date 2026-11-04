//! The open pages of each session (event streams) and the long polls (server/main.ts: streams, notify, push,
//! server/waiters.ts). They live in this process only, which is fine for one API process. A seat with an open
//! stream is "present", and a token without a seat is a watcher. Long polls do not count: an API client shows as away.
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;

use crate::error::{ApiError, ApiResult};
use crate::store::{Hooks, Store};

/// Each open page holds one event stream. This cap keeps a flood of streams from exhausting memory.
const MAX_STREAMS: usize = 10_000;
/// Each long poll holds one request. The same reason caps them.
const MAX_WAITERS: usize = 2000;
/// A long poll waits at most this long (WAIT_MS in server/api-docs.ts).
pub const WAIT: Duration = Duration::from_millis(25_000);

/// One message to an open page: a view as JSON, or "changed" for a page that must fetch its view.
pub type Message = String;

struct Stream {
    key: u64,
    token: Option<String>,
    /// Lets POST /leave close one stream: behind a proxy the close of a browser can reach this server late.
    id: Option<String>,
    send: mpsc::UnboundedSender<Message>,
}

pub struct Live {
    me: std::sync::Weak<Live>,
    /// The store thread calls `notify`, so the push tasks need the runtime by handle.
    runtime: tokio::runtime::Handle,
    store: OnceLock<Store>,
    streams: Mutex<HashMap<String, Vec<Stream>>>,
    stream_count: AtomicUsize,
    next_key: AtomicU64,
    /// Codes with a push running; true when a change came during the push.
    pushing: Mutex<HashMap<String, bool>>,
    waiters: Mutex<HashMap<String, Arc<Notify>>>,
    waiter_count: AtomicUsize,
}

impl Live {
    /// Call it inside the tokio runtime.
    pub fn new() -> Arc<Live> {
        Arc::new_cyclic(|me| Live {
            me: me.clone(),
            runtime: tokio::runtime::Handle::current(),
            store: OnceLock::new(),
            streams: Mutex::default(),
            stream_count: AtomicUsize::new(0),
            next_key: AtomicU64::new(0),
            pushing: Mutex::default(),
            waiters: Mutex::default(),
            waiter_count: AtomicUsize::new(0),
        })
    }

    pub fn set_store(&self, store: Store) {
        assert!(self.store.set(store).is_ok(), "the store is set once");
    }

    fn store(&self) -> &Store {
        self.store.get().expect("the store is set before the first request")
    }

    /// Adds an event stream. The page gets the messages of `notify` until it leaves, or until `close_all`.
    pub fn open(self: &Arc<Live>, code: &str, token: Option<String>, id: Option<String>) -> ApiResult<LiveStream> {
        if self.stream_count.load(Ordering::SeqCst) >= MAX_STREAMS {
            return Err(ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, "Too many live connections. Try again later."));
        }
        let (send, receive) = mpsc::unbounded_channel();
        let key = self.next_key.fetch_add(1, Ordering::SeqCst);
        let has_token = token.is_some();
        self.streams.lock().expect("the streams lock is not poisoned").entry(code.to_owned()).or_default().push(Stream {
            key,
            token,
            id,
            send,
        });
        self.stream_count.fetch_add(1, Ordering::SeqCst);
        // A player or a watcher arriving changes what the others see ("away" turns into "here", a new watcher).
        if has_token {
            self.notify(code);
        }
        Ok(LiveStream { receive, guard: StreamGuard { live: Arc::clone(self), code: code.to_owned(), key } })
    }

    /// Removes a stream. True when it was still open.
    fn drop_stream(&self, code: &str, key: u64) -> bool {
        let token = {
            let mut streams = self.streams.lock().expect("the streams lock is not poisoned");
            let Some(set) = streams.get_mut(code) else { return false };
            let Some(index) = set.iter().position(|stream| stream.key == key) else { return false };
            let stream = set.remove(index);
            if set.is_empty() {
                streams.remove(code);
            }
            stream.token
        };
        self.stream_count.fetch_sub(1, Ordering::SeqCst);
        if token.is_some() {
            self.notify(code);
        }
        true
    }

    /// POST /api/sessions/{code}/leave: closes the streams of this token with this stream id.
    pub fn leave(&self, code: &str, token: &str, id: &str) {
        let keys: Vec<u64> = {
            let streams = self.streams.lock().expect("the streams lock is not poisoned");
            streams
                .get(code)
                .map(|set| {
                    set.iter()
                        .filter(|stream| stream.token.as_deref() == Some(token) && stream.id.as_deref() == Some(id))
                        .map(|stream| stream.key)
                        .collect()
                })
                .unwrap_or_default()
        };
        for key in keys {
            self.drop_stream(code, key);
        }
    }

    /// Ends every stream, for a stop. The pages open a new stream after the retry time of the stream.
    pub fn close_all(&self) {
        let closed = std::mem::take(&mut *self.streams.lock().expect("the streams lock is not poisoned"));
        self.stream_count.fetch_sub(closed.values().map(Vec::len).sum(), Ordering::SeqCst);
    }

    /// A new name reaches the sessions that the player has open now. Other sessions show it with their next change.
    pub fn notify_player(&self, token: &str) {
        let codes: Vec<String> = {
            let streams = self.streams.lock().expect("the streams lock is not poisoned");
            streams
                .iter()
                .filter(|(_, set)| set.iter().any(|stream| stream.token.as_deref() == Some(token)))
                .map(|(code, _)| code.clone())
                .collect()
        };
        for code in codes {
            self.notify(&code);
        }
    }

    /// Sends the new view to every open page of a session, and wakes its long polls. Each page then needs no GET of
    /// its own (#253). While a push runs, more changes of the session lead to one more push, not one each.
    pub fn notify(&self, code: &str) {
        if let Some(waiters) = self.waiters.lock().expect("the waiters lock is not poisoned").get(code) {
            waiters.notify_waiters();
        }
        if !self.streams.lock().expect("the streams lock is not poisoned").contains_key(code) {
            return;
        }
        {
            let mut pushing = self.pushing.lock().expect("the pushing lock is not poisoned");
            if let Some(again) = pushing.get_mut(code) {
                *again = true;
                return;
            }
            pushing.insert(code.to_owned(), false);
        }
        let store = self.store().clone();
        let live = self.self_arc();
        let code = code.to_owned();
        self.runtime.spawn(async move { live.push(store, code).await });
    }

    fn self_arc(&self) -> Arc<Live> {
        self.me.upgrade().expect("the live registry outlives its tasks")
    }

    async fn push(&self, store: Store, code: String) {
        loop {
            self.pushing.lock().expect("the pushing lock is not poisoned").insert(code.clone(), false);
            let mut tokens: Vec<Option<String>> = self.streams_of(&code).into_iter().map(|(_, token)| token).collect();
            tokens.sort();
            tokens.dedup();
            let asked = tokens.clone();
            let views = {
                let code = code.clone();
                store.call(move |db| db.views(&code, &asked)).await
            };
            let views: HashMap<Option<String>, String> = match views {
                Ok(views) => tokens
                    .into_iter()
                    .zip(views)
                    .map(|(token, view)| (token, serde_json::to_string(&view).expect("a view serializes")))
                    .collect(),
                Err(error) => {
                    // A deleted session ends in a 404 on the fetch of each page, which shows it. Anything else is a fault.
                    if let ApiError::Fault(cause) = error {
                        eprintln!("push of {code} failed: {cause}");
                    }
                    HashMap::new()
                }
            };
            // A stream that opened during the push has no view yet: "changed" makes its page fetch one.
            let streams = self.streams.lock().expect("the streams lock is not poisoned");
            for stream in streams.get(&code).into_iter().flatten() {
                let _ = stream.send.send(views.get(&stream.token).cloned().unwrap_or_else(|| "changed".to_owned()));
            }
            drop(streams);
            let mut pushing = self.pushing.lock().expect("the pushing lock is not poisoned");
            if pushing.get(&code) != Some(&true) {
                pushing.remove(&code);
                return;
            }
        }
    }

    fn streams_of(&self, code: &str) -> Vec<(u64, Option<String>)> {
        let streams = self.streams.lock().expect("the streams lock is not poisoned");
        streams.get(code).map(|set| set.iter().map(|stream| (stream.key, stream.token.clone())).collect()).unwrap_or_default()
    }

    /// Waits until the version of the session is greater than `since`, or WAIT passes. The client can leave:
    /// axum then drops this future.
    pub async fn wait_for_change(&self, code: &str, since: u64) -> ApiResult<()> {
        if self.waiter_count.fetch_add(1, Ordering::SeqCst) >= MAX_WAITERS {
            self.waiter_count.fetch_sub(1, Ordering::SeqCst);
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "Too many requests wait now. Try again in a few seconds.",
            ));
        }
        let notify = Arc::clone(self.waiters.lock().expect("the waiters lock is not poisoned").entry(code.to_owned()).or_default());
        let _guard = WaiterGuard { live: self, code: code.to_owned() };
        let deadline = Instant::now() + WAIT;
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let asked = code.to_owned();
            let version = self.store().call(move |db| Ok(db.load(&asked)?.version)).await?;
            if version > since {
                return Ok(());
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(());
            }
        }
    }
}

struct WaiterGuard<'a> {
    live: &'a Live,
    code: String,
}

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        self.live.waiter_count.fetch_sub(1, Ordering::SeqCst);
        let mut waiters = self.live.waiters.lock().expect("the waiters lock is not poisoned");
        // Only this waiter and the map hold the Notify: it can go.
        if waiters.get(&self.code).is_some_and(|notify| Arc::strong_count(notify) <= 2) {
            waiters.remove(&self.code);
        }
    }
}

impl Hooks for Live {
    fn open_tokens(&self, code: &str) -> Vec<String> {
        self.streams_of(code).into_iter().filter_map(|(_, token)| token).collect()
    }

    fn changed(&self, code: &str) {
        self.notify(code);
    }
}

/// Removes its stream when the page goes (axum drops the body).
struct StreamGuard {
    live: Arc<Live>,
    code: String,
    key: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.live.drop_stream(&self.code, self.key);
    }
}

/// The messages to one open page.
pub struct LiveStream {
    receive: mpsc::UnboundedReceiver<Message>,
    guard: StreamGuard,
}

impl tokio_stream::Stream for LiveStream {
    type Item = Message;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Message>> {
        let _ = &self.guard;
        self.receive.poll_recv(context)
    }
}

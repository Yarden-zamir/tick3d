//! Limits per client address.
use std::collections::{BTreeMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Mutex;

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};

use crate::error::ApiError;

/// The address of the client: the last X-Forwarded-For entry (the one that Caddy added), else the socket.
pub fn client_of(headers: &HeaderMap, peer: SocketAddr) -> String {
    let forwarded = headers.get_all("x-forwarded-for").iter().filter_map(|value| value.to_str().ok()).collect::<Vec<_>>().join(",");
    let last = forwarded.rsplit(',').next().map(str::trim).unwrap_or("");
    if last.is_empty() { peer.ip().to_string() } else { last.to_owned() }
}

struct Window {
    count: u32,
    ends_at: i64,
}

/// Allows each client `limit` actions per window, and refuses more with 429 until the window ends.
/// It keeps at most `max_clients` windows: when full, it forgets the client with the oldest window.
/// Limit: the counts live in this process only and reset on a restart. An IPv6 client can change its address.
/// Revisit this with more than one API process, a real attack, or real players that share one address.
pub struct Limiter {
    limit: u32,
    window_ms: i64,
    max_clients: usize,
    message: &'static str,
    windows: Mutex<(BTreeMap<String, Window>, VecDeque<String>)>,
}

impl Limiter {
    pub const fn new(limit: u32, window_ms: i64, max_clients: usize, message: &'static str) -> Limiter {
        Limiter { limit, window_ms, max_clients, message, windows: Mutex::new((BTreeMap::new(), VecDeque::new())) }
    }

    pub fn allow(&self, client: &str, now: i64) -> Result<(), ApiError> {
        let mut guard = self.windows.lock().expect("the limiter lock is not poisoned");
        let (windows, order) = &mut *guard;
        let expired = windows.get(client).is_none_or(|window| window.ends_at <= now);
        if expired {
            windows.remove(client);
            order.retain(|known| known != client);
            if windows.len() >= self.max_clients
                && let Some(oldest) = order.pop_front()
            {
                windows.remove(&oldest);
            }
            windows.insert(client.to_owned(), Window { count: 0, ends_at: now + self.window_ms });
            order.push_back(client.to_owned());
        }
        let window = windows.get_mut(client).expect("the window exists");
        window.count += 1;
        if window.count <= self.limit {
            return Ok(());
        }
        let retry = ((window.ends_at - now) as f64 / 1000.0).ceil().max(1.0) as i64;
        let headers: Vec<(HeaderName, HeaderValue)> = vec![(header::RETRY_AFTER, HeaderValue::from(retry))];
        Err(ApiError::Refusal { status: StatusCode::TOO_MANY_REQUESTS, message: self.message.to_owned(), code: None, headers })
    }
}

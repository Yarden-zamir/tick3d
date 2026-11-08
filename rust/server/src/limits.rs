//! Limits per player token and per client address.
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

/// The address limit of a PlayerLimit is this many times its player limit.
pub const ADDRESS_FACTOR: u32 = 20;

/// A limit per player token, and a looser one per address. Phones behind one carrier NAT share an address, so the
/// player limit is the real one. The address limit stops one client that makes many tokens.
/// Limit: a player can make new tokens, so an attacker on many addresses passes both. Revisit with a real attack.
pub struct PlayerLimit {
    player: Limiter,
    address: Limiter,
}

impl PlayerLimit {
    pub const fn new(per_player: u32, window_ms: i64, message: &'static str) -> PlayerLimit {
        PlayerLimit {
            player: Limiter::new(per_player, window_ms, 10_000, message),
            address: Limiter::new(per_player * ADDRESS_FACTOR, window_ms, 10_000, message),
        }
    }

    pub fn allow(&self, token: &str, client: &str, now: i64) -> Result<(), ApiError> {
        self.address.allow(client, now)?;
        self.player.allow(token, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_behind_one_address_each_get_their_own_limit() {
        let limit = PlayerLimit::new(2, 60_000, "no");
        // Three players on one carrier address: each gets 2.
        for player in ["a", "b", "c"] {
            assert!(limit.allow(player, "198.51.100.7", 0).is_ok());
            assert!(limit.allow(player, "198.51.100.7", 0).is_ok());
            assert!(limit.allow(player, "198.51.100.7", 0).is_err(), "{player} gets a third");
        }
        // A new window starts after the window ends.
        assert!(limit.allow("a", "198.51.100.7", 60_000).is_ok());
    }

    #[test]
    fn one_address_with_many_players_stops_at_the_address_limit() {
        let limit = PlayerLimit::new(1, 60_000, "no");
        let allowed = (0..100).filter(|n| limit.allow(&format!("player-{n}"), "203.0.113.9", 0).is_ok()).count();
        assert_eq!(allowed, ADDRESS_FACTOR as usize);
        // Another address is not affected.
        assert!(limit.allow("player-0", "203.0.113.10", 0).is_err(), "player-0 used its 1 already");
        assert!(limit.allow("player-new", "203.0.113.10", 0).is_ok());
    }
}

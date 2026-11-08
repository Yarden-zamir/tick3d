//! The Nearby lobby and its routes: open Nearby games that devices on the same network see in a list.
//! A web page cannot broadcast or discover on a local network, so a host announces its game through this server.
//!
//! The first announcement of a game answers at once with its id. Then the host holds one announce request with that id
//! open. The request ends with the answer code of a guest, or after WAIT_MS, and the host then sends the next request.
//! The entry stays while a request is open, and for GRACE_MS after one ends. When the host closes the page, its request
//! closes, and the entry goes at once.
//!
//! Limit: the entries live in this process only, like the event streams. Revisit this with more than one API process.
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::limits::{Limiter, client_of};
use crate::live::WAIT;
use crate::sessions::{MAX_BODY_BYTES, ok_json, player_of, read_json, require_player};
use crate::signal::{DeviceKind, Hello, MAX_CODE_LENGTH, SignalKind, decode_signal};
use crate::store::now_ms;

/// NEARBY_HOSTS_PER_NETWORK and NEARBY_GRACE_MS in contract/api-docs.ts, and the total of the lobby.
const PER_NETWORK: usize = 10;
const TOTAL: usize = 1000;
const GRACE_MS: i64 = 10_000;
const HOST_ID_LENGTH: usize = 16;
const HOST_ID_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Nearby calls per network: 120 per 10 minutes (NEARBY_CALLS_PER_10_MINUTES).
static ALLOW_NEARBY: Limiter = Limiter::new(120, 600_000, 10_000, "Too many Nearby calls from this network. Try again later.");

/// The network of a client address: an IPv4 address exactly, an IPv6 address by its /64 prefix.
/// The devices of one home share one public IPv4 address (NAT) or one IPv6 /64 prefix.
/// Limit: a home where one device uses IPv4 and another IPv6 has two networks here, so the two do not see each other.
/// Revisit this when players report it; the code flow still connects them.
pub fn network_of(address: &str) -> Option<String> {
    let plain = address.split('%').next().unwrap_or("");
    if plain.parse::<Ipv4Addr>().is_ok() {
        return Some(plain.to_owned());
    }
    let ip: Ipv6Addr = plain.parse().ok()?;
    // An IPv4 client on an IPv6 socket (::ffff:a.b.c.d).
    let lower = plain.to_lowercase();
    if let Some(v4) = lower.strip_prefix("::ffff:").filter(|v4| v4.parse::<Ipv4Addr>().is_ok()) {
        return Some(v4.to_owned());
    }
    let [a, b, c, d, ..] = ip.segments();
    Some(format!("{a:x}:{b:x}:{c:x}:{d:x}::/64"))
}

fn require_network(headers: &HeaderMap, peer: SocketAddr) -> ApiResult<String> {
    network_of(&client_of(headers, peer)).ok_or_else(|| ApiError::bad_request("The server cannot tell the network of this request."))
}

fn as_host_id(value: &str) -> Option<String> {
    (value.len() == HOST_ID_LENGTH && only_host_chars(value)).then(|| value.to_owned())
}

fn only_host_chars(value: &str) -> bool {
    value.chars().all(|char| HOST_ID_CHARS.contains(char))
}

/// isCode in src/nearby/lobby.ts: only the shape. The route decodes each code fully before the lobby gets it.
fn code_of(value: Option<&Value>) -> Option<String> {
    let code = value?.as_str()?;
    (1..=MAX_CODE_LENGTH).contains(&crate::protocol::js_length(code)).then(|| code.to_owned())
}

struct Entry {
    token: String,
    network: String,
    hello: Hello,
    offer: String,
    /// A WebRTC offer takes one answer. A used offer stays out of the list until the host sends a new one.
    used: bool,
    since: i64,
    /// When the last open request of the host ended.
    ended_at: i64,
    /// The open request of the host: its serial, and the channel that ends it with an answer code or with None.
    held: Option<(u64, oneshot::Sender<Option<String>>)>,
    /// An answer that came while the host had no request open.
    answer: Option<String>,
}

impl Entry {
    fn present(&self, now: i64) -> bool {
        self.held.is_some() || now - self.ended_at < GRACE_MS
    }

    /// Ends the open request with `answer`.
    fn finish(&mut self, answer: Option<String>, now: i64) {
        if let Some((_, sender)) = self.held.take() {
            self.ended_at = now;
            // The host can be gone already; its guard then removes the entry.
            let _ = sender.send(answer);
        }
    }
}

/// A host as a guest sees it in the list.
#[derive(Serialize)]
pub struct LobbyHost {
    id: String,
    name: String,
    device: DeviceKind,
    age: i64,
    offer: String,
}

/// What an announcement gives the route.
enum Announced {
    /// The answer to send now.
    Now { id: String, answer: Option<String> },
    /// A held request: wait on `answer` for at most WAIT_MS.
    Held { id: String, serial: u64, answer: oneshot::Receiver<Option<String>> },
}

#[derive(Default)]
pub struct Lobby {
    state: Mutex<LobbyState>,
}

#[derive(Default)]
struct LobbyState {
    entries: HashMap<String, Entry>,
    serial: u64,
}

impl LobbyState {
    fn sweep(&mut self, now: i64) {
        self.entries.retain(|_, entry| entry.present(now));
    }
}

fn new_host_id() -> String {
    let mut bytes = [0u8; 12];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

impl Lobby {
    fn lock(&self) -> std::sync::MutexGuard<'_, LobbyState> {
        self.state.lock().expect("the lobby lock is not poisoned")
    }

    /// Adds the entry of a host and answers at once, or keeps the entry of `id` and holds the request.
    fn announce(&self, id: Option<String>, token: String, network: String, hello: Hello, offer: String) -> ApiResult<Announced> {
        let now = now_ms();
        let mut state = self.lock();
        state.sweep(now);
        let Some(id) = id else {
            if state.entries.len() >= TOTAL {
                return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Too many games are in the list now. Try again later."));
            }
            if state.entries.values().filter(|other| other.network == network).count() >= PER_NETWORK {
                // Limit: no time frees a slot for sure, because a host that stays keeps its slot. This is the longest time
                // that a host that left without a word stays. Revisit when hosts fill a network often.
                let retry = (WAIT.as_millis() as u64 + GRACE_MS as u64).div_ceil(1000);
                return Err(ApiError::Refusal {
                    status: StatusCode::TOO_MANY_REQUESTS,
                    message: format!("This network has {PER_NETWORK} games in the list already."),
                    code: None,
                    headers: vec![(header::RETRY_AFTER, HeaderValue::from(retry))],
                });
            }
            let id = new_host_id();
            let entry = Entry { token, network, hello, offer, used: false, since: now, ended_at: now, held: None, answer: None };
            state.entries.insert(id.clone(), entry);
            // The page learns its id at once, and shows that the game is in the list.
            return Ok(Announced::Now { id, answer: None });
        };
        state.serial += 1;
        let serial = state.serial;
        let entry = state.entries.get_mut(&id).filter(|entry| entry.token == token && entry.network == network).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "This game is not in the list any more. Announce it again without an id.")
        })?;
        // A new request takes the place of an open one.
        entry.finish(None, now);
        if offer != entry.offer {
            entry.offer = offer;
            entry.used = false;
        }
        entry.hello = hello;
        if let Some(answer) = entry.answer.take() {
            entry.ended_at = now;
            return Ok(Announced::Now { id, answer: Some(answer) });
        }
        let (sender, answer) = oneshot::channel();
        entry.held = Some((serial, sender));
        Ok(Announced::Held { id, serial, answer })
    }

    /// Ends the held request `serial` after WAIT_MS. False when an answer or a newer request ended it first.
    fn time_out(&self, id: &str, serial: u64) -> bool {
        let mut state = self.lock();
        match state.entries.get_mut(id) {
            Some(entry) if entry.held.as_ref().is_some_and(|(held, _)| *held == serial) => {
                entry.finish(None, now_ms());
                true
            }
            _ => false,
        }
    }

    /// The host left during a held request: the entry goes.
    fn left(&self, id: &str, serial: u64) {
        let mut state = self.lock();
        if state.entries.get(id).is_some_and(|entry| entry.held.as_ref().is_some_and(|(held, _)| *held == serial)) {
            state.entries.remove(id);
        }
    }

    /// The open games on a network, without the games of `token`. A used offer is not listed.
    fn list(&self, network: &str, token: Option<&str>) -> Vec<LobbyHost> {
        let now = now_ms();
        let mut state = self.lock();
        state.sweep(now);
        state
            .entries
            .iter()
            .filter(|(_, entry)| entry.network == network && !entry.used && Some(entry.token.as_str()) != token)
            .map(|(id, entry)| LobbyHost {
                id: id.clone(),
                name: entry.hello.name.clone(),
                device: entry.hello.device,
                age: (now - entry.since) / 1000,
                offer: entry.offer.clone(),
            })
            .collect()
    }

    /// Passes the answer code of a guest to the host. A host on another network does not exist for the guest.
    /// Only the current offer of the host can connect.
    fn answer(&self, id: &str, network: &str, offer: &str, code: String) -> ApiResult<()> {
        let now = now_ms();
        let mut state = self.lock();
        state.sweep(now);
        let entry = state
            .entries
            .get_mut(id)
            .filter(|entry| entry.network == network)
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "This game is not in the list any more."))?;
        if entry.used || entry.offer != offer {
            return Err(ApiError::new(StatusCode::CONFLICT, "Another device joins this game now. Try again in a few seconds."));
        }
        entry.used = true;
        if entry.held.is_some() {
            entry.finish(Some(code), now);
        } else {
            entry.answer = Some(code);
        }
        Ok(())
    }
}

/// Removes the entry when the host request ends before its answer: axum drops the handler when the client goes away.
struct HoldGuard<'a> {
    lobby: &'a Lobby,
    id: &'a str,
    serial: u64,
    done: bool,
}

impl Drop for HoldGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.lobby.left(self.id, self.serial);
        }
    }
}

/// Decodes a signal code fully, so the lobby never holds a code that a device cannot read.
fn signal_hello(code: &str, kind: SignalKind) -> ApiResult<Hello> {
    match decode_signal(code) {
        Some((found, hello)) if found == kind => Ok(hello),
        _ => Err(ApiError::bad_request(format!("This is not a valid tick3d {} code.", kind.as_str()))),
    }
}

pub async fn hosts(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> ApiResult<Response> {
    let network = require_network(&headers, peer)?;
    Ok(ok_json(StatusCode::OK, &json!({ "hosts": app.lobby.list(&network, player_of(&headers).as_deref()) })))
}

pub async fn announce(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let network = require_network(&headers, peer)?;
    ALLOW_NEARBY.allow(&network, now_ms())?;
    let body = read_json(body, MAX_BODY_BYTES).await?;
    let bad = || ApiError::bad_request("An announcement needs an offer code, and an id from an earlier answer or none.");
    let offer = code_of(body.get("offer")).ok_or_else(bad)?;
    let id = match body.get("id") {
        None => None,
        Some(id) => Some(id.as_str().and_then(as_host_id).ok_or_else(bad)?),
    };
    let hello = signal_hello(&offer, SignalKind::Offer)?;
    let (id, answer) = match app.lobby.announce(id, token, network, hello, offer)? {
        Announced::Now { id, answer } => (id, answer),
        Announced::Held { id, serial, mut answer } => {
            let mut guard = HoldGuard { lobby: &app.lobby, id: &id, serial, done: false };
            let code = match tokio::time::timeout(WAIT, &mut answer).await {
                Ok(code) => code.ok().flatten(),
                // An answer or a newer request can end the hold right at the time out: then the channel holds its value.
                Err(_) if app.lobby.time_out(&id, serial) => None,
                Err(_) => answer.try_recv().ok().flatten(),
            };
            guard.done = true;
            drop(guard);
            (id, code)
        }
    };
    Ok(ok_json(StatusCode::OK, &json!({ "id": id, "answer": answer })))
}

pub async fn answer(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(host): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let id = as_host_id(&host).ok_or_else(|| ApiError::bad_request("A host id has 16 characters."))?;
    require_player(&headers)?;
    let network = require_network(&headers, peer)?;
    ALLOW_NEARBY.allow(&network, now_ms())?;
    let body = read_json(body, MAX_BODY_BYTES).await?;
    let (Some(answer), Some(offer)) = (code_of(body.get("answer")), code_of(body.get("offer"))) else {
        return Err(ApiError::bad_request("An answer needs an answer code and the offer code that it answers."));
    };
    signal_hello(&answer, SignalKind::Answer)?;
    app.lobby.answer(&id, &network, &offer, answer)?;
    Ok(ok_json(StatusCode::OK, &json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn networks_group_ipv6_by_prefix() {
        assert_eq!(network_of("203.0.113.5").as_deref(), Some("203.0.113.5"));
        assert_eq!(network_of("::ffff:203.0.113.5").as_deref(), Some("203.0.113.5"));
        assert_eq!(network_of("2001:DB8:0:12::1%eth0").as_deref(), Some("2001:db8:0:12::/64"));
        assert_eq!(network_of("2001:db8::1").as_deref(), Some("2001:db8:0:0::/64"));
        assert_eq!(network_of("unknown"), None);
    }

    fn hello() -> Hello {
        Hello { device: DeviceKind::Phone, name: "Ann".into() }
    }

    #[tokio::test]
    async fn a_held_request_gets_the_answer_of_a_guest() {
        let lobby = Lobby::default();
        let net = || "1.2.3.4".to_owned();
        let Announced::Now { id, .. } = lobby.announce(None, "host".into(), net(), hello(), "offer1".into()).expect("added") else {
            panic!("a new entry answers at once")
        };
        assert_eq!(lobby.list(&net(), Some("guest")).len(), 1);
        assert!(lobby.list(&net(), Some("host")).is_empty());
        let Announced::Held { answer, .. } =
            lobby.announce(Some(id.clone()), "host".into(), net(), hello(), "offer1".into()).expect("held")
        else {
            panic!("a known entry holds the request")
        };
        assert!(lobby.answer(&id, &net(), "old offer", "a".into()).is_err());
        lobby.answer(&id, &net(), "offer1", "answer1".into()).expect("answered");
        assert_eq!(answer.await.expect("sent"), Some("answer1".into()));
        assert!(lobby.list(&net(), Some("guest")).is_empty());
    }

    #[test]
    fn a_host_that_leaves_during_a_hold_leaves_the_list() {
        let lobby = Lobby::default();
        let Announced::Now { id, .. } = lobby.announce(None, "host".into(), "n".into(), hello(), "o".into()).expect("added") else {
            panic!("a new entry answers at once")
        };
        let Announced::Held { serial, .. } =
            lobby.announce(Some(id.clone()), "host".into(), "n".into(), hello(), "o".into()).expect("held")
        else {
            panic!("a known entry holds the request")
        };
        drop(HoldGuard { lobby: &lobby, id: &id, serial, done: false });
        assert!(lobby.list("n", None).is_empty());
    }
}

//! One WebSocket per page for play (step 4 of #265): GET /api/ws?player=<token>. The page sends its session actions and
//! gets the views of the sessions that it watches over one connection, instead of a request per move and an event stream
//! per session. REST and long polls stay as the agent API.
//!
//! The page sends JSON messages:
//! - `{"id": 7, "method": "POST", "path": "/sessions/ABCD/moves", "body": {...}}`: a session action. It runs through the
//!   same router as REST, so every check, limit and Idempotency-Key rule is the same. The answer is
//!   `{"id": 7, "status": 200, "body": {...}}`.
//! - `{"watch": "ABCD"}` and `{"unwatch": "ABCD"}`: the views of a session. A watch counts as an open page of the session
//!   (presence), as an event stream does. A push is `{"code": "ABCD", "view": {...}}`, or `"view": "changed"` when the
//!   page must load the session.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;
use tower::ServiceExt;

use crate::App;
use crate::error::{ApiError, ApiResult};
use crate::protocol::as_player_token;
use crate::routes;
use crate::sessions::session_code;

/// The largest message that a page sends: a chat line or a move is far smaller.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// A ping this often keeps an idle socket open through the proxies (Cloudflare closes after 100 s).
const PING: Duration = Duration::from_secs(25);
/// The sessions that one socket can watch at once. A page watches one.
const MAX_WATCHES: usize = 8;
/// Messages that wait for a slow page. A watch that finds the queue full drops the view and sends "changed" when there
/// is room again, so the page loads the session and misses nothing; the memory of one socket stays bounded.
const OUTGOING: usize = 64;
/// The actions of one socket that run at once. The page sends one action at a time (it waits for each answer), so a
/// socket above this is not the page: the server closes it, and the page reconnects. This bounds the tasks, the waiting
/// answers and the store jobs of one socket.
/// Limit: the store queue itself (store/mod.rs) is shared with HTTP and has no bound, as in the Node server: many sockets
/// or requests together can still queue many jobs. Revisit with a global admission limit if the store queue ever grows
/// under real load.
const MAX_ACTIONS_IN_FLIGHT: usize = 8;
/// The last parts of a session path that a socket action may name, after /sessions/{code}: the play actions of the page
/// (src/online.ts api). The event stream, leave and the maintainer routes stay on HTTP.
const ACTIONS: [&str; 8] = ["join", "moves", "games", "chat", "playoff", "lock", "seats", "seats/answer"];

#[derive(Deserialize)]
pub struct SocketQuery {
    player: Option<String>,
}

/// A message from the page.
#[derive(Deserialize)]
#[serde(untagged)]
enum Incoming {
    Action { id: u64, method: String, path: String, body: Option<Value> },
    Watch { watch: String },
    Unwatch { unwatch: String },
}

pub async fn socket(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<SocketQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    // A browser cannot send the X-Player header with a WebSocket, so the token comes in the address, as for the event stream.
    let token = query.player.as_deref().and_then(as_player_token).ok_or_else(|| ApiError::bad_request("Missing or invalid player."))?;
    // The address of the client counts for the limits of the actions, as for a request.
    let forwarded = headers.get("x-forwarded-for").cloned();
    Ok(upgrade.max_message_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| serve(app, socket, token, peer, forwarded)).into_response())
}

async fn serve(app: App, mut socket: WebSocket, token: String, peer: SocketAddr, forwarded: Option<HeaderValue>) {
    let router = routes::router(app.clone());
    // Pushes and answers wait here, so the tasks never write to the socket at the same time.
    let (out, mut outgoing) = mpsc::channel::<String>(OUTGOING);
    let mut watches: HashMap<String, JoinHandle<()>> = HashMap::new();
    let in_flight = Arc::new(Semaphore::new(MAX_ACTIONS_IN_FLIGHT));
    let mut ping = tokio::time::interval(PING);
    ping.tick().await;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break };
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    _ => continue,
                };
                match serde_json::from_str::<Incoming>(&text) {
                    Ok(Incoming::Action { id, method, path, body }) => {
                        let Ok(permit) = Arc::clone(&in_flight).try_acquire_owned() else {
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        };
                        let (router, out, token, forwarded) = (router.clone(), out.clone(), token.clone(), forwarded.clone());
                        // Each action runs in its own task: a slow action does not hold up the pushes, and a page that
                        // leaves does not cancel a move that the store already applies. The permit ends with the task.
                        tokio::spawn(async move {
                            let _permit = permit;
                            let (status, body) = act(router, &token, peer, forwarded, &method, &path, body).await;
                            // An answer waits for room: the page needs every answer.
                            let _ = out.send(envelope(id, status, &body)).await;
                        });
                    }
                    Ok(Incoming::Watch { watch }) => {
                        if let Err(error) = start_watch(&app, &mut watches, &watch, &token, &out).await {
                            let _ = out.try_send(json!({ "code": watch, "error": error_text(&error) }).to_string());
                        }
                    }
                    Ok(Incoming::Unwatch { unwatch }) => {
                        if let Some(task) = watches.remove(&unwatch) {
                            task.abort();
                        }
                    }
                    Err(_) => {
                        let _ = out.try_send(json!({ "error": "A message must be an action, a watch or an unwatch." }).to_string());
                    }
                }
            }
            Some(text) = outgoing.recv() => {
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }
    // The watches end with the socket, so the other player sees "away" at once.
    for task in watches.into_values() {
        task.abort();
    }
}

/// Registers a live stream for the session and forwards its messages. The stream leaves when the task ends.
async fn start_watch(
    app: &App,
    watches: &mut HashMap<String, JoinHandle<()>>,
    code: &str,
    token: &str,
    out: &mpsc::Sender<String>,
) -> ApiResult<()> {
    let code = session_code(code)?;
    if watches.contains_key(&code) {
        return Ok(());
    }
    if watches.len() >= MAX_WATCHES {
        return Err(ApiError::bad_request(format!("A socket watches at most {MAX_WATCHES} sessions.")));
    }
    // 404 before the watch starts, as for the event stream.
    let known = code.clone();
    app.store.call(move |db| db.load(&known).map(drop)).await?;
    let stream = app.live.open(&code, Some(token.to_owned()), None)?;
    let task = tokio::spawn(forward(stream, out.clone(), code.clone()));
    watches.insert(code, task);
    Ok(())
}

/// Forwards the messages of one live stream to the queue of the socket. A view that finds the queue full is dropped, and
/// "changed" goes out as soon as the queue has room again, also when no later change comes: the page then loads the
/// session. So a slow page misses nothing, and the queue stays bounded.
async fn forward<S: tokio_stream::Stream<Item = String> + Unpin>(mut stream: S, out: mpsc::Sender<String>, code: String) {
    use tokio_stream::StreamExt;
    let changed = json!({ "code": code, "view": "changed" }).to_string();
    // The first message after a watch: the page loads the session, as after the open of an event stream.
    let mut missed = out.try_send(changed.clone()).is_err();
    loop {
        if missed {
            // Wait for room or for the next message, whichever comes first. Room sends "changed" now.
            tokio::select! {
                room = out.reserve() => {
                    let Ok(room) = room else { return };
                    room.send(changed.clone());
                    missed = false;
                    continue;
                }
                message = stream.next() => {
                    if message.is_none() {
                        return;
                    }
                    // The page loads the session anyway once there is room: this view adds nothing.
                    continue;
                }
            }
        }
        let Some(message) = stream.next().await else { return };
        // A view is JSON text already: put it in as it is, without a parse and a new serialization.
        let text = if message == "changed" { changed.clone() } else { format!("{{\"code\":\"{code}\",\"view\":{message}}}") };
        match out.try_send(text) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => missed = true,
            Err(mpsc::error::TrySendError::Closed(_)) => return,
        }
    }
}

fn error_text(error: &ApiError) -> String {
    match error {
        ApiError::Refusal { message, .. } => message.clone(),
        ApiError::Fault(_) => "Server error.".into(),
    }
}

/// Runs one session action through the router, as a request of this player would.
async fn act(
    router: Router,
    token: &str,
    peer: SocketAddr,
    forwarded: Option<HeaderValue>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (u16, Bytes) {
    let refused = || (400, Bytes::from_static(br#"{"error":"A socket action is a play action of a session (see src/online.ts api)."}"#));
    let Ok(method) = method.parse::<Method>() else { return refused() };
    if !is_play_action(&method, path) {
        return refused();
    }
    // The path passed is_play_action (a code and fixed words), but a request that does not build is a refusal, not a panic.
    let Ok(mut request) = Request::builder()
        .method(method)
        .uri(format!("/api{path}"))
        .header("x-player", token)
        .header("content-type", "application/json")
        .body(Body::from(body.map(|body| body.to_string()).unwrap_or_default()))
    else {
        return refused();
    };
    if let Some(forwarded) = forwarded {
        request.headers_mut().insert("x-forwarded-for", forwarded);
    }
    request.extensions_mut().insert(ConnectInfo(peer));
    let Ok(response) = router.oneshot(request).await;
    let status = response.status().as_u16();
    // No size cap: a play action answers with one session view, as over HTTP, and the allow-list keeps the event stream
    // and long polls out. A cap could answer 500 for a move that the store applied (a long session has a large view).
    let Ok(bytes) = axum::body::to_bytes(response.into_body(), usize::MAX).await else {
        return (500, Bytes::from_static(br#"{"error":"Server error."}"#));
    };
    (status, bytes)
}

/// The answer of an action: the JSON bytes of the handler go in as they are, without a parse into a `Value` and a new
/// serialization (about 0.16 ms of the 3 ms of server CPU per move, measured on 2026-11-04). A body that is not one JSON
/// value (an empty body, bytes that are not UTF-8, text after the value) becomes null, as before. The check parses
/// without building anything.
/// Limit: the check accepts some JSON that a parse into `Value` refuses: 1e999, an escaped lone surrogate, nesting deeper
/// than 128. Those bytes go in as they are and are still JSON, where the old code sent null. The handlers serialize with
/// serde_json and do not write such JSON. Check this again if an answer body comes from somewhere else.
fn envelope(id: u64, status: u16, body: &[u8]) -> String {
    let body = match std::str::from_utf8(body) {
        Ok(text) if serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok() => text,
        _ => "null",
    };
    format!(r#"{{"id":{id},"status":{status},"body":{body}}}"#)
}

/// The play actions of the page, and nothing else: POST /sessions, GET or PATCH /sessions/{code} (without a query, so no
/// long poll), and POST /sessions/{code}/<an action of ACTIONS>. `code` is 4 letters or digits.
fn is_play_action(method: &Method, path: &str) -> bool {
    if path == "/sessions" {
        return method == Method::POST;
    }
    let Some(rest) = path.strip_prefix("/sessions/") else { return false };
    let (code, action) = rest.split_once('/').map_or((rest, None), |(code, action)| (code, Some(action)));
    if code.len() != 4 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return false;
    }
    match action {
        None => *method == Method::GET || *method == Method::PATCH,
        Some(action) => *method == Method::POST && ACTIONS.contains(&action),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The last change is dropped on a full queue; when the page reads the queue empty, "changed" follows with no later change.
    #[tokio::test]
    async fn a_dropped_view_is_followed_by_changed_once_the_queue_has_room() {
        let (out, mut queue) = mpsc::channel::<String>(2);
        let (messages, stream) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(forward(tokio_stream::wrappers::UnboundedReceiverStream::new(stream), out.clone(), "AB12".into()));
        // The watch sends "changed" first; then the page is slow and the queue fills up.
        assert!(queue.recv().await.unwrap().contains("changed"));
        out.send("other 1".into()).await.unwrap();
        out.send("other 2".into()).await.unwrap();
        // The last change of the session: its view finds the queue full.
        messages.send(r#"{"version":7}"#.into()).unwrap();
        tokio::task::yield_now().await;
        // The page reads the queue empty. No later change comes.
        assert_eq!(queue.recv().await.unwrap(), "other 1");
        assert_eq!(queue.recv().await.unwrap(), "other 2");
        let next = tokio::time::timeout(std::time::Duration::from_secs(1), queue.recv()).await.expect("a message follows").unwrap();
        assert_eq!(next, r#"{"code":"AB12","view":"changed"}"#);
        task.abort();
    }

    #[test]
    fn puts_the_answer_body_in_as_it_is() {
        let view = br#"{"code":"AB12","version":3,"you":"X"}"#;
        let text = envelope(7, 200, view);
        let parsed: Value = serde_json::from_str(&text).unwrap();
        // The same answer as the earlier parse and serialization.
        assert_eq!(parsed, json!({ "id": 7, "status": 200, "body": serde_json::from_slice::<Value>(view).unwrap() }));
        assert_eq!(envelope(8, 200, b""), r#"{"id":8,"status":200,"body":null}"#);
        assert_eq!(serde_json::from_str::<Value>(&envelope(9, 400, b"{not json")).unwrap()["body"], Value::Null);
    }

    /// Each answer is one JSON message with the body in its own field, whatever bytes the body holds.
    #[test]
    fn an_answer_body_cannot_break_the_message() {
        let body_of = |bytes: &[u8]| serde_json::from_str::<Value>(&envelope(1, 200, bytes)).expect("one JSON message")["body"].clone();
        // Not UTF-8 inside a string: null, no panic.
        assert_eq!(body_of(b"\"\xff\""), Value::Null);
        // Text after the value cannot add fields to the message.
        assert_eq!(body_of(br#"{}, "id": 2"#), Value::Null);
        assert_eq!(body_of(br#"{"a":1}}"#), Value::Null);
        // Escapes and UTF-8 stay as they are.
        assert_eq!(body_of(r#"{"name":"a\"b\\cé ✓ 🎲","id":9}"#.as_bytes()), json!({ "name": "a\"b\\cé ✓ 🎲", "id": 9 }));
        assert_eq!(serde_json::from_str::<Value>(&envelope(3, 200, br#"{"id":9}"#)).unwrap()["id"], 3);
    }

    #[test]
    fn allows_the_play_actions_of_the_page_only() {
        for (method, path) in [
            (Method::POST, "/sessions"),
            (Method::GET, "/sessions/AB12"),
            (Method::PATCH, "/sessions/AB12"),
            (Method::POST, "/sessions/AB12/moves"),
            (Method::POST, "/sessions/AB12/seats/answer"),
        ] {
            assert!(is_play_action(&method, path), "{method} {path}");
        }
        for (method, path) in [
            (Method::GET, "/sessions/AB12/events"),
            (Method::POST, "/sessions/AB12/leave"),
            (Method::GET, "/sessions/AB12?wait=3"),
            (Method::DELETE, "/sessions/AB12/chat/1"),
            (Method::GET, "/sessions"),
            (Method::POST, "/sessions/AB 1/moves"),
            (Method::POST, "/sessions/AB12/../me"),
            (Method::GET, "/me"),
        ] {
            assert!(!is_play_action(&method, path), "{method} {path}");
        }
    }
}

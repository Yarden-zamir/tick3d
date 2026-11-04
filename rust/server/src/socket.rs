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
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
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
/// The largest answer of an action: a session view is far smaller.
const MAX_ANSWER_BYTES: usize = 1 << 20;
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
                        let (router, out, token, forwarded) = (router.clone(), out.clone(), token.clone(), forwarded.clone());
                        // Each action runs in its own task: a slow action does not hold up the pushes, and a page that
                        // leaves does not cancel a move that the store already applies.
                        tokio::spawn(async move {
                            let (status, body) = act(router, &token, peer, forwarded, &method, &path, body).await;
                            // An answer waits for room: the page needs every answer.
                            let _ = out.send(json!({ "id": id, "status": status, "body": body }).to_string()).await;
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
    let mut stream = app.live.open(&code, Some(token.to_owned()), None)?;
    let (out, pushed) = (out.clone(), code.clone());
    let task = tokio::spawn(async move {
        use tokio_stream::StreamExt;
        let changed = json!({ "code": pushed, "view": "changed" }).to_string();
        // The first message after a watch: the page loads the session, as after the open of an event stream.
        let mut missed = out.try_send(changed.clone()).is_err();
        while let Some(message) = stream.next().await {
            // A view is JSON text already: put it in as it is, without a parse and a new serialization. After a dropped
            // view, the next message is "changed", so the page loads the session instead of missing the change.
            let text =
                if message == "changed" || missed { changed.clone() } else { format!("{{\"code\":\"{pushed}\",\"view\":{message}}}") };
            match out.try_send(text) {
                Ok(()) => missed = false,
                Err(mpsc::error::TrySendError::Full(_)) => missed = true,
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    });
    watches.insert(code, task);
    Ok(())
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
) -> (u16, Value) {
    let refused = || (400, json!({ "error": "A socket action is a play action of a session (see src/online.ts api)." }));
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
    let Ok(bytes) = axum::body::to_bytes(response.into_body(), MAX_ANSWER_BYTES).await else {
        return (500, json!({ "error": "Server error." }));
    };
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
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

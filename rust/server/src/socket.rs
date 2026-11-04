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
    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
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
                            let _ = out.send(json!({ "id": id, "status": status, "body": body }).to_string());
                        });
                    }
                    Ok(Incoming::Watch { watch }) => {
                        if let Err(error) = start_watch(&app, &mut watches, &watch, &token, &out).await {
                            let _ = out.send(json!({ "code": watch, "error": error_text(&error) }).to_string());
                        }
                    }
                    Ok(Incoming::Unwatch { unwatch }) => {
                        if let Some(task) = watches.remove(&unwatch) {
                            task.abort();
                        }
                    }
                    Err(_) => {
                        let _ = out.send(json!({ "error": "A message must be an action, a watch or an unwatch." }).to_string());
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
    out: &mpsc::UnboundedSender<String>,
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
        // The first message after a watch: the page loads the session, as after the open of an event stream.
        let _ = out.send(json!({ "code": pushed, "view": "changed" }).to_string());
        while let Some(message) = stream.next().await {
            // A view is JSON text already: put it in as it is, without a parse and a new serialization.
            let text = if message == "changed" {
                json!({ "code": pushed, "view": "changed" }).to_string()
            } else {
                format!("{{\"code\":\"{pushed}\",\"view\":{message}}}")
            };
            if out.send(text).is_err() {
                break;
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
    // Play only: the agent API and the other routes stay on HTTP.
    let allowed = path == "/sessions" || path.starts_with("/sessions/");
    let Ok(method) = method.parse::<Method>() else { return (400, json!({ "error": "Unknown method." })) };
    if !allowed || !matches!(method, Method::GET | Method::POST | Method::PATCH | Method::DELETE) || path.contains("..") {
        return (400, json!({ "error": "A socket action is a session request: a path under /sessions." }));
    }
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api{path}"))
        .header("x-player", token)
        .header("content-type", "application/json")
        .body(Body::from(body.map(|body| body.to_string()).unwrap_or_default()))
        .expect("a session request builds");
    if let Some(forwarded) = forwarded {
        request.headers_mut().insert("x-forwarded-for", forwarded);
    }
    request.extensions_mut().insert(ConnectInfo(peer));
    let Ok(response) = router.oneshot(request).await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap_or_default();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

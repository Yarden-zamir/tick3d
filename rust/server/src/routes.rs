//! Every route of server/main.ts. The test below checks this table against the documented routes, so every route
//! that the server handles has docs, and every documented route has a handler.
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::{MethodFilter, MethodRouter, on};
use serde_json::json;

use crate::App;
use crate::account;
use crate::docs;
use crate::error::{ApiError, no_store};
use crate::idempotency;
use crate::login;
use crate::moderation;
use crate::sessions;
use axum::middleware::from_fn_with_state;

type Entry = (&'static str, fn(MethodFilter) -> MethodRouter<App>);

/// The routes, by the name in server/api-docs.ts.
static ROUTES: &[Entry] = &[
    ("GET /api/health", |method| on(method, health)),
    ("GET /api/openapi.json", |method| on(method, docs::openapi)),
    ("GET /api/docs", |method| on(method, docs::docs_page)),
    ("POST /api/sessions", |method| on(method, sessions::create)),
    ("GET /api/sessions/{code}", |method| on(method, sessions::get)),
    ("GET /api/sessions/{code}/events", |method| on(method, sessions::events)),
    ("POST /api/sessions/{code}/leave", |method| on(method, sessions::leave)),
    ("PATCH /api/sessions/{code}", |method| on(method, sessions::update)),
    ("POST /api/sessions/{code}/lock", |method| on(method, sessions::lock)),
    ("POST /api/sessions/{code}/join", |method| on(method, sessions::join)),
    ("POST /api/sessions/{code}/moves", |method| on(method, sessions::moves)),
    ("POST /api/sessions/{code}/games", |method| on(method, sessions::new_game)),
    ("POST /api/sessions/{code}/seats", |method| on(method, sessions::seats)),
    ("POST /api/sessions/{code}/seats/answer", |method| on(method, sessions::answer_seat)),
    ("POST /api/sessions/{code}/chat", |method| on(method, sessions::chat)),
    ("POST /api/sessions/{code}/playoff", |method| on(method, sessions::playoff)),
    ("GET /api/auth/login", |method| on(method, login::github_login)),
    ("GET /api/auth/github/callback", |method| on(method, login::github_callback)),
    ("GET /api/auth/google/login", |method| on(method, login::google_login)),
    ("GET /api/auth/google/callback", |method| on(method, login::google_callback)),
    ("POST /api/auth/google/one-tap", |method| on(method, login::google_one_tap)),
    ("POST /api/auth/logout", |method| on(method, login::logout)),
    ("GET /api/me", |method| on(method, account::get_me)),
    ("DELETE /api/me", |method| on(method, account::delete_me)),
    ("GET /api/deleted", |method| on(method, account::deleted)),
    ("PUT /api/me/name", |method| on(method, account::set_name)),
    ("DELETE /api/me/name", |method| on(method, account::clear_name)),
    ("PUT /api/me/avatar", |method| on(method, account::set_avatar)),
    ("GET /api/me/stats-privacy", |method| on(method, account::get_stats_privacy)),
    ("PUT /api/me/stats-privacy", |method| on(method, account::set_stats_privacy)),
    ("GET /api/me/blocks", |method| on(method, account::get_blocks)),
    ("PUT /api/me/blocks/{person}", |method| on(method, account::block)),
    ("DELETE /api/me/blocks/{person}", |method| on(method, account::unblock)),
    ("POST /api/events", |method| on(method, moderation::event)),
    ("POST /api/reports", |method| on(method, moderation::report)),
    ("GET /api/reports", |method| on(method, moderation::reports)),
    ("DELETE /api/sessions/{code}/chat/{message}", |method| on(method, moderation::hide_message)),
    ("DELETE /api/players/{person}/name", |method| on(method, moderation::clear_name_of)),
    ("DELETE /api/players/{person}", |method| on(method, moderation::delete_person)),
    ("DELETE /api/accounts/{login}", |method| on(method, moderation::delete_account)),
];

fn method_filter(method: &str) -> MethodFilter {
    match method {
        "GET" => MethodFilter::GET,
        "POST" => MethodFilter::POST,
        "PUT" => MethodFilter::PUT,
        "PATCH" => MethodFilter::PATCH,
        "DELETE" => MethodFilter::DELETE,
        other => panic!("no method filter for {other}"),
    }
}

fn split(name: &str) -> (&str, &str) {
    name.split_once(' ').unwrap_or_else(|| panic!("a route name is 'METHOD /path': {name}"))
}

/// A documented route that this server does not handle yet.
/// Limit: the Rust server is not complete until this list is empty. Remove it with the last ported route.
async fn not_ported() -> ApiError {
    ApiError::new(StatusCode::NOT_IMPLEMENTED, "The Rust server does not have this route yet.")
}

pub fn router(app: App) -> Router {
    let mut router = Router::new();
    for (name, handler) in ROUTES {
        let (method, path) = split(name);
        let documented = docs::documented_routes().iter().find(|route| route.name == *name).unwrap_or_else(|| panic!("{name} has no docs"));
        let handler = handler(method_filter(method));
        let handler = if documented.idempotency_key { handler.layer(from_fn_with_state(app.clone(), idempotency::keyed)) } else { handler };
        router = router.route(path, handler);
    }
    for route in docs::documented_routes() {
        if ROUTES.iter().any(|(name, _)| *name == route.name) {
            continue;
        }
        let (method, path) = split(&route.name);
        router = router.route(path, on(method_filter(method), not_ported));
    }
    router
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "Not found.") })
        .method_not_allowed_fallback(|| async { ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.") })
        .with_state(app)
}

async fn health(State(app): State<App>) -> impl IntoResponse {
    let lan = app.lan_host.as_ref().map(|name| json!({ "name": name }));
    (no_store(), Json(json!({ "ok": true, "lan": lan })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_has_docs() {
        for (name, _) in ROUTES {
            assert!(docs::documented_routes().iter().any(|route| route.name == *name), "{name} has no docs");
        }
    }
}

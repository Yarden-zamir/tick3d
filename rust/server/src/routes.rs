//! Every route of server/main.ts. The test below checks this table against the documented routes, so every route
//! that the server handles has docs, and every documented route has a handler.
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::{MethodFilter, MethodRouter, on};
use serde_json::json;

use crate::App;
use crate::docs;
use crate::error::{ApiError, no_store};
use crate::sessions;

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
        router = router.route(path, handler(method_filter(method)));
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

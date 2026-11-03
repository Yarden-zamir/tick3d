//! The routes and the docs of server/api-docs.ts, from rust/server/from-node.json.
use std::sync::LazyLock;

use axum::http::{HeaderMap, HeaderName, header};
use axum::response::IntoResponse;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentedRoute {
    /// "METHOD /path", with path parameters in braces.
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Docs {
    routes: Vec<DocumentedRoute>,
    openapi: String,
    docs_html: String,
}

static DOCS: LazyLock<Docs> = LazyLock::new(|| serde_json::from_str(include_str!("../from-node.json")).expect("from-node.json parses"));

pub fn documented_routes() -> &'static [DocumentedRoute] {
    &DOCS.routes
}

/// The address that the docs show. A LAN host (compose.lan.yml) serves plain HTTP, and its Caddy says so.
/// Cloudflare terminates TLS for every public request, and the kitshn tunnel keeps the Host header.
fn docs_origin(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    let proto = headers.get("x-forwarded-proto").and_then(|value| value.to_str().ok());
    if proto == Some("http") { format!("http://{host}") } else { format!("https://{host}") }
}

/// The docs are public, so any site and any agent may read them.
fn public_text(content_type: &'static str, body: String) -> impl IntoResponse {
    let headers: [(HeaderName, &'static str); 3] =
        [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache"), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")];
    (headers, body)
}

pub async fn openapi(headers: HeaderMap) -> impl IntoResponse {
    public_text("application/json", DOCS.openapi.replace("{origin}", &docs_origin(&headers)))
}

pub async fn docs_page() -> impl IntoResponse {
    public_text("text/html; charset=utf-8", DOCS.docs_html.clone())
}

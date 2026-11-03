//! The error answer of every route: `{ "error": message }`, and `code` for a refusal that a client tests.
use axum::Json;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tick3d_core::session::{ErrorCode, SessionError};

#[derive(Debug)]
pub enum ApiError {
    /// A refusal that the client sees: its status and message.
    Refusal { status: StatusCode, message: String, code: Option<ErrorCode>, headers: Vec<(HeaderName, HeaderValue)> },
    /// A fault of the server. The client sees only "Server error.", the log gets the cause.
    Fault(String),
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> ApiError {
        ApiError::Refusal { status, message: message.into(), code: None, headers: Vec::new() }
    }

    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn fault(cause: impl std::fmt::Display) -> ApiError {
        ApiError::Fault(cause.to_string())
    }
}

impl From<SessionError> for ApiError {
    fn from(error: SessionError) -> ApiError {
        let status = StatusCode::from_u16(error.status as u16).expect("a session error has a valid HTTP status");
        ApiError::Refusal { status, message: error.message, code: error.code, headers: Vec::new() }
    }
}

impl From<duckdb::Error> for ApiError {
    fn from(error: duckdb::Error) -> ApiError {
        ApiError::fault(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Refusal { status, message, code, headers } => {
                let body = match code {
                    None => json!({ "error": message }),
                    Some(code) => json!({ "error": message, "code": code }),
                };
                let mut response = (status, no_store(), Json(body)).into_response();
                response.headers_mut().extend(headers.into_iter().map(|(name, value)| (Some(name), value)));
                response
            }
            ApiError::Fault(cause) => {
                eprintln!("server error: {cause}");
                (StatusCode::INTERNAL_SERVER_ERROR, no_store(), Json(json!({ "error": "Server error." }))).into_response()
            }
        }
    }
}

/// Every JSON answer of the API: a client must never show an old one.
pub fn no_store() -> [(HeaderName, &'static str); 1] {
    [(header::CACHE_CONTROL, "no-store")]
}

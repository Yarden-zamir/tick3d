//! The login routes (/api/auth/...). The OAuth calls block on the network, so they run in
//! `spawn_blocking`. Logins are rare, so a blocking client is enough.
use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::App;
use crate::account::origin_of;
use crate::auth::{Auth, GoogleClient, Login, Redirect};
use crate::error::{ApiError, ApiResult, no_store};
use crate::sessions::{MAX_BODY_BYTES, ok_json, read_json, require_player};
use crate::store::{GoogleProfile, now_ms};

type Params = Query<HashMap<String, String>>;

fn redirect(Redirect { location, cookies }: Redirect) -> ApiResult<Response> {
    let mut response = (StatusCode::FOUND, no_store()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::LOCATION, HeaderValue::from_str(&location).map_err(ApiError::fault)?);
    for cookie in cookies {
        headers.append(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(ApiError::fault)?);
    }
    Ok(response)
}

/// A failed login returns to the page with a reason: `taken` when the login already has its own account.
fn login_failed(provider: &str, error: &ApiError) -> ApiResult<Response> {
    eprintln!("{provider} login failed: {error:?}");
    let taken = matches!(error, ApiError::Refusal { status: StatusCode::CONFLICT, .. });
    redirect(Redirect { location: (if taken { "/?login=taken" } else { "/?login=failed" }).into(), cookies: Vec::new() })
}

fn login_off() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Login is not available on this server.")
}

fn google_off() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Google login is not available on this server.")
}

impl App {
    fn login(&self) -> ApiResult<&Auth> {
        self.auth.as_ref().ok_or_else(login_off)
    }

    fn google(&self) -> ApiResult<(&Auth, &GoogleClient)> {
        let auth = self.auth.as_ref().ok_or_else(google_off)?;
        Ok((auth, auth.config.google.as_ref().ok_or_else(google_off)?))
    }

    /// Runs a blocking OAuth step with the login settings.
    async fn blocking<R: Send + 'static>(&self, step: impl FnOnce(&Auth) -> R + Send + 'static) -> ApiResult<R> {
        let app = self.clone();
        tokio::task::spawn_blocking(move || step(app.auth.as_ref().expect("login is on")))
            .await
            .map_err(|_| ApiError::fault("a login step panicked"))
    }

    /// The end of a login callback. A browser that holds a login of the other provider connects the new login to that
    /// account, and keeps its cookie. Else the new login opens its account, with its cookie.
    async fn after_login(&self, headers: &HeaderMap, user: Login, profile: Option<GoogleProfile>, done: Redirect) -> ApiResult<Response> {
        let current = self.user(headers);
        let same_kind = |current: &Login| matches!(current, Login::Google { .. }) == matches!(user, Login::Google { .. });
        match current {
            Some(current) if !same_kind(&current) => {
                self.store.call(move |db| db.connect_login(&current, &user)).await?;
                redirect(Redirect { location: done.location, cookies: vec![self.login()?.clear_state()] })
            }
            _ => {
                self.store.call(move |db| db.account_of_login(&user, profile.as_ref())).await?;
                redirect(done)
            }
        }
    }
}

pub async fn github_login(State(app): State<App>, headers: HeaderMap, Query(params): Params) -> ApiResult<Response> {
    redirect(app.login()?.start(&origin_of(&headers), params.get("return").map(String::as_str), now_ms()))
}

pub async fn github_callback(State(app): State<App>, headers: HeaderMap, Query(params): Params) -> ApiResult<Response> {
    app.login()?;
    let request = headers.clone();
    let finished = app
        .blocking(move |auth| {
            auth.finish(&request, params.get("code").map(String::as_str), params.get("state").map(String::as_str), now_ms())
        })
        .await?;
    let outcome = match finished {
        Ok((user, done)) => app.after_login(&headers, user, None, done).await,
        Err(error) => Err(ApiError::fault(error)),
    };
    outcome.or_else(|error| login_failed("GitHub", &error))
}

pub async fn google_login(State(app): State<App>, headers: HeaderMap, Query(params): Params) -> ApiResult<Response> {
    let (auth, google) = app.google()?;
    redirect(auth.google_start(google, &origin_of(&headers), params.get("return").map(String::as_str), now_ms()))
}

pub async fn google_callback(State(app): State<App>, headers: HeaderMap, Query(params): Params) -> ApiResult<Response> {
    app.google()?;
    let request = headers.clone();
    let finished = app
        .blocking(move |auth| {
            let google = auth.config.google.as_ref().expect("Google login is on");
            auth.google_finish(google, &request, params.get("code").map(String::as_str), params.get("state").map(String::as_str), now_ms())
        })
        .await?;
    let outcome = match finished {
        Ok((sign_in, location)) => {
            let cookies = app.login()?.google_cookies(&sign_in.google, now_ms());
            app.after_login(&headers, Login::Google { google: sign_in.google }, Some(sign_in.profile), Redirect { location, cookies }).await
        }
        Err(error) => Err(ApiError::fault(error)),
    };
    outcome.or_else(|error| login_failed("Google", &error))
}

/// A cross-site form cannot send the X-Player header, so another site cannot log a player in.
pub async fn google_one_tap(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    app.google()?;
    let token = require_player(&headers)?;
    let body = read_json(body, MAX_BODY_BYTES).await?;
    let credential = body
        .get("credential")
        .and_then(|credential| credential.as_str())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad_request("The body needs the credential of Google One Tap."))?;
    let sign_in = app
        .blocking(move |auth| auth.one_tap(auth.config.google.as_ref().expect("Google login is on"), &credential, now_ms()))
        .await?
        .map_err(|error| {
            eprintln!("Google One Tap failed: {error}");
            ApiError::new(StatusCode::UNAUTHORIZED, "Google did not confirm this login.")
        })?;
    let google = sign_in.google.clone();
    let user = Login::Google { google: google.clone() };
    let (owner, linked) = (token.clone(), user.clone());
    app.store.call(move |db| db.link_token(&owner, &linked, Some(&sign_in.profile))).await?;
    let mut response = ok_json(StatusCode::OK, &app.me(token, Some(user), &origin_of(&headers)).await?);
    for cookie in app.login()?.google_cookies(&google, now_ms()) {
        response.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(ApiError::fault)?);
    }
    Ok(response)
}

/// A cross-site form cannot send the X-Player header, so another site cannot log a player out.
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let auth = app.login()?;
    let cookie = HeaderValue::from_str(&auth.logout_cookie()).map_err(ApiError::fault)?;
    let token = require_player(&headers)?;
    app.store.call(move |db| db.unlink_token(&token)).await?;
    let mut response = ok_json(StatusCode::OK, &json!({ "ok": true }));
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

//! The routes of the player's own account (server/main.ts: GET /api/me, name, avatar, stats-privacy, blocks).
//! A cross-site form cannot send the X-Player header, so another site cannot change a player's account.
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use serde_json::{Value, json};
use tick3d_core::session::{LoginProvider, PlayerInfo};

use crate::App;
use crate::auth::{Login, is_maintainer};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{parse_avatar_request, parse_block_request, parse_custom_name, parse_person_id, parse_stats_privacy};
use crate::sessions::{MAX_BODY_BYTES, ok_json, read_json, require_player};
use crate::store::now_ms;

/// The origin of the page, for Google One Tap.
fn origin_of(headers: &HeaderMap) -> String {
    format!("https://{}", headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or(""))
}

pub fn require_person(value: &str) -> ApiResult<String> {
    parse_person_id(value).ok_or_else(|| ApiError::bad_request("A person id has 16 characters from 0-9 and a-f."))
}

impl App {
    /// The account of the login cookie, when login is on and the cookie is valid.
    pub fn user(&self, headers: &HeaderMap) -> Option<Login> {
        self.auth.as_ref()?.user(headers, now_ms())
    }

    /// A maintainer, by the GitHub login of the account cookie. The X-Player header is also required, so another
    /// site cannot send a moderation request with the cookie of a maintainer.
    pub fn require_maintainer(&self, headers: &HeaderMap) -> ApiResult<String> {
        require_player(headers)?;
        let auth = self.auth.as_ref().ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Login is not available on this server."))?;
        let Some(Login::GitHub { login, .. }) = auth.user(headers, now_ms()) else {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Log in with GitHub first."));
        };
        if !is_maintainer(&login) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the maintainers can do this."));
        }
        Ok(login)
    }

    /// The answer of GET /api/me: the login state, the custom name and the public person id.
    async fn me(&self, token: String, user: Option<Login>, origin: &str) -> ApiResult<Value> {
        let state = self
            .store
            .call(move |db| {
                let logins = if user.is_some() { db.logins_of(&token)? } else { (None, false) };
                // The stored account holds the name and picture choices. A device that is not linked yet has none.
                let account = match &user {
                    None => None,
                    Some(user) => db.account(&token)?.or_else(|| match user {
                        Login::GitHub { login, avatar, .. } => Some(PlayerInfo {
                            provider: LoginProvider::Github,
                            login: login.clone(),
                            avatar: Some(avatar.clone()),
                            name: None,
                            seed: None,
                        }),
                        Login::Google { .. } => None,
                    }),
                };
                Ok((logins, account, db.custom_name(&token)?, db.has_copy(&token)?, db.person(&token)?))
            })
            .await?;
        let ((github, google), account, name, has_copy, person) = state;
        let auth = self.auth.as_ref();
        Ok(json!({
            "loginAvailable": auth.is_some(),
            "user": account,
            "name": name,
            "googleLogin": auth.is_some_and(|auth| auth.config.google.is_some()),
            "googleOneTapClient": auth.and_then(|auth| auth.one_tap_client(origin)),
            "githubLogin": github,
            "googleConnected": google,
            "hasCopy": has_copy,
            "person": person,
        }))
    }

    /// Links this browser to the account of its login cookie, and returns the account id.
    async fn link(&self, token: &str, user: &Option<Login>) -> ApiResult<Option<i64>> {
        let Some(user) = user.clone() else { return Ok(None) };
        let token = token.to_owned();
        Ok(Some(self.store.call(move |db| db.link_token(&token, &user)).await?))
    }

    async fn me_after_change(&self, headers: &HeaderMap, token: String, user: Option<Login>) -> ApiResult<Response> {
        self.live.notify_player(&token);
        Ok(ok_json(StatusCode::OK, &self.me(token, user, &origin_of(headers)).await?))
    }
}

pub async fn get_me(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let user = app.user(&headers);
    // Every visit with a login links this browser to the account, so a new device joins at once.
    app.link(&token, &user).await?;
    Ok(ok_json(StatusCode::OK, &app.me(token, user, &origin_of(&headers)).await?))
}

pub async fn set_name(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let body = read_json(body, MAX_BODY_BYTES).await?;
    let name = body
        .get("name")
        .and_then(parse_custom_name)
        .ok_or_else(|| ApiError::bad_request("A name needs 2 to 24 letters, digits, spaces, \"-\" or \"_\"."))?;
    // With a login, the name is the account's, on every device.
    let user = app.user(&headers);
    let account = app.link(&token, &user).await?;
    let owner = token.clone();
    app.store.call(move |db| db.set_name(&owner, &name, account)).await?;
    app.me_after_change(&headers, token, user).await
}

pub async fn clear_name(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let user = app.user(&headers);
    let account = app.link(&token, &user).await?;
    let owner = token.clone();
    app.store.call(move |db| db.clear_name(&owner, account)).await?;
    app.me_after_change(&headers, token, user).await
}

pub async fn set_avatar(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let picture = parse_avatar_request(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("picture is \"github\" or \"generated\"."))?;
    let user = app.user(&headers);
    if user.is_none() {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Log in first."));
    }
    let account = app.link(&token, &user).await?.expect("a login links an account");
    app.store.call(move |db| db.set_avatar(account, picture)).await?;
    app.me_after_change(&headers, token, user).await
}

pub async fn get_stats_privacy(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let hidden = app.store.call(move |db| db.stats_private(&token)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "private": hidden })))
}

pub async fn set_stats_privacy(State(app): State<App>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let hidden = parse_stats_privacy(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("The setting needs \"private\": true or false."))?;
    let hidden = app
        .store
        .call(move |db| {
            db.set_stats_private(&token, hidden)?;
            db.stats_private(&token)
        })
        .await?;
    Ok(ok_json(StatusCode::OK, &json!({ "private": hidden })))
}

pub async fn get_blocks(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let blocked = app.store.call(move |db| db.blocks(&token)).await?;
    Ok(ok_json(StatusCode::OK, &json!({ "blocked": blocked })))
}

pub async fn block(State(app): State<App>, Path(person): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let person = require_person(&person)?;
    let name = parse_block_request(&read_json(body, MAX_BODY_BYTES).await?)
        .ok_or_else(|| ApiError::bad_request("A block needs the name that you saw: 1 to 40 characters."))?;
    let blocked = app
        .store
        .call(move |db| {
            db.block(&token, &person, &name)?;
            db.blocks(&token)
        })
        .await?;
    Ok(ok_json(StatusCode::OK, &json!({ "blocked": blocked })))
}

pub async fn unblock(State(app): State<App>, Path(person): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let token = require_player(&headers)?;
    let person = require_person(&person)?;
    let blocked = app
        .store
        .call(move |db| {
            db.unblock(&token, &person)?;
            db.blocks(&token)
        })
        .await?;
    Ok(ok_json(StatusCode::OK, &json!({ "blocked": blocked })))
}

//! GitHub and Google login (server/auth.ts). Login is optional: a player plays with a browser token either way.
//! A login links that token to an account, so sessions and stats follow the player across devices.
//! The account cookie is set for COOKIE_DOMAIN and its subdomains. Every environment that shares AUTH_SECRET can
//! check the cookie. Without the GitHub settings, login is off.
use axum::http::{HeaderMap, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;

use std::collections::HashMap;
use std::sync::Mutex;

use url::Url;

use crate::protocol::{GITHUB_PICTURES, is_github_login, parse_custom_name};
use crate::store::GoogleProfile;

const USER_COOKIE: &str = "t3_user";
const STATE_COOKIE: &str = "t3_oauth";
const USER_DAYS: i64 = 90;
const STATE_MINUTES: i64 = 10;
const GOOGLE_PICTURES: &str = "https://lh3.googleusercontent.com/";
// Google's sign-in addresses (OpenID Connect discovery: https://accounts.google.com/.well-known/openid-configuration).
const GOOGLE_AUTHORIZE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
/// Google rotates its signing keys about weekly and publishes the next one early, so an hour is safe.
const GOOGLE_KEYS_MS: i64 = 3_600_000;
/// A token with an unknown key fetches the keys again, at most once in this time.
const GOOGLE_KEYS_RETRY_MS: i64 = 60_000;

/// Where a login step sends the browser, with the cookies to set.
pub struct Redirect {
    pub location: String,
    pub cookies: Vec<String>,
}

/// A Google sign-in: the subject id with the name and photo from Google.
pub struct GoogleSignIn {
    pub google: String,
    pub profile: GoogleProfile,
}

/// An RSA public key: modulus and exponent.
type RsaKey = (Vec<u8>, Vec<u8>);
/// The RSA keys of Google by key id, and when they came.
type GoogleKeys = (HashMap<String, RsaKey>, i64);

/// The settings of login, from the environment of the process.
pub struct AuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub secret: String,
    /// https://tick3d.yarden-zamir.com: the origin that GitHub returns to.
    pub origin: String,
    /// tick3d.yarden-zamir.com: the cookie is valid here and on every subdomain.
    pub cookie_domain: String,
    /// The web client of Google sign-in. None when Google login is off.
    pub google: Option<GoogleClient>,
}

pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: String,
}

/// The account of an account cookie.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Login {
    GitHub {
        id: i64,
        login: String,
        avatar: String,
    },
    /// Google's subject id of the account. The cookie holds only this id.
    Google {
        google: String,
    },
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl AuthConfig {
    /// authConfigFromEnv: None when login is off. Some but not all settings is a deploy mistake, so it panics at
    /// the start instead of silently turning login off.
    pub fn from_env() -> Option<AuthConfig> {
        let (google_id, google_secret) = (env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"));
        assert_eq!(google_id.is_some(), google_secret.is_some(), "Google login needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
        let secrets = [env("GITHUB_CLIENT_ID"), env("GITHUB_CLIENT_SECRET"), env("AUTH_SECRET")];
        if secrets.iter().all(Option::is_none) {
            assert!(google_id.is_none(), "Google login needs the GitHub login settings too");
            return None;
        }
        let [Some(client_id), Some(client_secret), Some(secret)] = secrets else {
            panic!("GitHub login needs all of GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_SECRET, AUTH_ORIGIN and COOKIE_DOMAIN")
        };
        let (Some(origin), Some(cookie_domain)) = (env("AUTH_ORIGIN"), env("COOKIE_DOMAIN")) else {
            panic!("GitHub login needs all of GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_SECRET, AUTH_ORIGIN and COOKIE_DOMAIN")
        };
        assert!(secret.encode_utf16().count() >= 32, "AUTH_SECRET needs at least 32 characters");
        let google = google_id.zip(google_secret).map(|(client_id, client_secret)| GoogleClient { client_id, client_secret });
        Some(AuthConfig { client_id, client_secret, secret, origin, cookie_domain, google })
    }
}

pub struct Auth {
    pub config: AuthConfig,
    google_keys: Mutex<Option<GoogleKeys>>,
}

/// A JSON object field as a text.
fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn json_part(part: &str) -> Result<Map<String, Value>, String> {
    let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|_| "the ID token is not a JWT")?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err("the ID token is not a JWT".into()),
    }
}

impl Auth {
    pub fn new(config: AuthConfig) -> Auth {
        Auth { config, google_keys: Mutex::new(None) }
    }

    fn mac(&self, body: &str) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.config.secret.as_bytes()).expect("HMAC takes a key of any length");
        mac.update(body.as_bytes());
        mac
    }

    /// A signed value: the base64url JSON payload, ".", and the base64url HMAC of that text.
    pub fn sign(&self, payload: &Value) -> String {
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_string(payload).expect("a payload serializes"));
        let signature = URL_SAFE_NO_PAD.encode(self.mac(&body).finalize().into_bytes());
        format!("{body}.{signature}")
    }

    /// The payload of a value that this server signed and that has not expired.
    pub fn verify(&self, value: &str, now: i64) -> Option<Map<String, Value>> {
        let (body, signature) = value.split_once('.')?;
        if signature.contains('.') {
            return None;
        }
        self.mac(body).verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?).ok()?;
        let payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
        let payload = payload.as_object()?;
        let expires = payload.get("exp")?.as_f64()?;
        (expires > now as f64).then(|| payload.clone())
    }

    /// The account behind this request, if it carries a valid account cookie.
    pub fn user(&self, headers: &HeaderMap, now: i64) -> Option<Login> {
        let payload = self.verify(&read_cookie(headers, USER_COOKIE)?, now)?;
        if let Some(google) = payload.get("google").and_then(Value::as_str) {
            return Some(Login::Google { google: google.to_owned() });
        }
        let id = payload.get("id")?.as_i64()?;
        // githubInfoOf: the login and picture pass parsePlayerInfo as a GitHub account.
        let login = payload.get("login")?.as_str().filter(|login| is_github_login(login))?;
        let avatar = payload.get("avatar")?.as_str().filter(|avatar| avatar.starts_with(GITHUB_PICTURES))?;
        Some(Login::GitHub { id, login: login.to_owned(), avatar: avatar.to_owned() })
    }

    pub fn logout_cookie(&self) -> String {
        cookie(USER_COOKIE, "", 0, Some(&self.config.cookie_domain), "/")
    }

    /// The client for Google One Tap on this page, or None. Google accepts One Tap only on the origins of the client,
    /// so a preview gets only the login button.
    pub fn one_tap_client(&self, request_origin: &str) -> Option<&str> {
        let google = self.config.google.as_ref()?;
        (request_origin == self.config.origin).then_some(google.client_id.as_str())
    }
}

impl Auth {
    /// A return address must be on our own domain, so the login can never send a player elsewhere.
    fn safe_return(&self, value: Option<&str>) -> String {
        let home = format!("{}/", self.config.origin.trim_end_matches('/'));
        let Some(url) = value.and_then(|value| Url::parse(value).ok()) else { return home };
        let domain = &self.config.cookie_domain;
        let ours = url.host_str().is_some_and(|host| host == domain || host.ends_with(&format!(".{domain}")));
        if url.scheme() == "https" && ours { url.to_string() } else { home }
    }

    /// A preview sends the player to the same login path on the login origin first.
    fn via_login_origin(&self, path: &str, return_to: Option<&str>) -> Redirect {
        let mut url = Url::parse(&self.config.origin).expect("AUTH_ORIGIN is a URL").join(path).expect("a login path joins");
        url.query_pairs_mut().append_pair("return", &self.safe_return(return_to));
        Redirect { location: url.to_string(), cookies: Vec::new() }
    }

    /// The signed state of a login and its nonce cookie. The cookie proves that this browser started the login.
    fn new_state(&self, return_to: Option<&str>, now: i64) -> (String, String) {
        let mut nonce = [0u8; 16];
        rand::fill(&mut nonce);
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let state =
            self.sign(&serde_json::json!({ "nonce": nonce, "return": self.safe_return(return_to), "exp": now + STATE_MINUTES * 60_000 }));
        (state, cookie(STATE_COOKIE, &nonce, STATE_MINUTES * 60, None, "/api/auth"))
    }

    /// The return address of a login that this browser started, or an error.
    fn check_state(&self, headers: &HeaderMap, state: Option<&str>, now: i64) -> Result<String, String> {
        let invalid = || "the login state is invalid or expired".to_owned();
        let payload = state.and_then(|state| self.verify(state, now)).ok_or_else(invalid)?;
        let nonce = read_cookie(headers, STATE_COOKIE).ok_or_else(invalid)?;
        if text(&payload, "nonce") != Some(nonce.as_str()) {
            return Err(invalid());
        }
        text(&payload, "return").map(str::to_owned).ok_or_else(invalid)
    }

    fn account_cookie(&self, mut payload: Map<String, Value>, now: i64) -> String {
        payload.insert("exp".into(), Value::from(now + USER_DAYS * 86_400_000));
        cookie(USER_COOKIE, &self.sign(&Value::Object(payload)), USER_DAYS * 86_400, Some(&self.config.cookie_domain), "/")
    }

    pub fn clear_state(&self) -> String {
        cookie(STATE_COOKIE, "", 0, None, "/api/auth")
    }

    /// The cookies after a Google login: the account cookie, and the cleared login state. The cookie holds only the
    /// subject id: the profile is stored at the sign-in.
    pub fn google_cookies(&self, google: &str, now: i64) -> Vec<String> {
        let mut payload = Map::new();
        payload.insert("google".into(), Value::from(google));
        vec![self.account_cookie(payload, now), self.clear_state()]
    }

    /// Starts a GitHub login. A preview sends the player to the login origin first.
    pub fn start(&self, request_origin: &str, return_to: Option<&str>, now: i64) -> Redirect {
        if request_origin != self.config.origin {
            return self.via_login_origin("/api/auth/login", return_to);
        }
        let (state, state_cookie) = self.new_state(return_to, now);
        let mut url = Url::parse("https://github.com/login/oauth/authorize").expect("a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", &format!("{}/api/auth/github/callback", self.config.origin))
            .append_pair("state", &state)
            // No scope: the public profile (id, login, avatar) is all the game uses.
            .append_pair("scope", "");
        Redirect { location: url.to_string(), cookies: vec![state_cookie] }
    }

    /// Finishes a GitHub login: checks the state, asks GitHub who the player is, and sets the account cookie.
    /// It blocks on the network: call it from `spawn_blocking`.
    pub fn finish(&self, headers: &HeaderMap, code: Option<&str>, state: Option<&str>, now: i64) -> Result<(Login, Redirect), String> {
        let location = self.check_state(headers, state, now)?;
        let code = code.ok_or("GitHub sent no code")?;
        let token: Value = ureq::post("https://github.com/login/oauth/access_token")
            .header("accept", "application/json")
            .send_json(serde_json::json!({
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "code": code,
                "redirect_uri": format!("{}/api/auth/github/callback", self.config.origin),
            }))
            .and_then(|mut response| response.body_mut().read_json())
            .map_err(|error| error.to_string())?;
        let access = token.get("access_token").and_then(Value::as_str).ok_or("GitHub refused the login code")?;
        let profile: Value = ureq::get("https://api.github.com/user")
            .header("authorization", &format!("Bearer {access}"))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "tick3d")
            .call()
            .and_then(|mut response| response.body_mut().read_json())
            .map_err(|error| error.to_string())?;
        let id = profile.get("id").and_then(Value::as_i64);
        let login = profile.get("login").and_then(Value::as_str).filter(|login| is_github_login(login));
        let avatar = profile.get("avatar_url").and_then(Value::as_str).filter(|avatar| avatar.starts_with(GITHUB_PICTURES));
        let (Some(id), Some(login), Some(avatar)) = (id, login, avatar) else { return Err("GitHub sent an unexpected profile".into()) };
        let user = Login::GitHub { id, login: login.to_owned(), avatar: avatar.to_owned() };
        let mut payload = Map::new();
        payload.insert("id".into(), Value::from(id));
        payload.insert("login".into(), Value::from(login));
        payload.insert("avatar".into(), Value::from(avatar));
        Ok((user, Redirect { location, cookies: vec![self.account_cookie(payload, now), self.clear_state()] }))
    }

    /// Starts a Google login. The profile scope gives the name and photo, which show like a GitHub login and picture.
    pub fn google_start(&self, google: &GoogleClient, request_origin: &str, return_to: Option<&str>, now: i64) -> Redirect {
        if request_origin != self.config.origin {
            return self.via_login_origin("/api/auth/google/login", return_to);
        }
        let (state, state_cookie) = self.new_state(return_to, now);
        let mut url = Url::parse(GOOGLE_AUTHORIZE).expect("a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", &google.client_id)
            .append_pair("redirect_uri", &format!("{}/api/auth/google/callback", self.config.origin))
            .append_pair("response_type", "code")
            .append_pair("scope", "openid profile")
            .append_pair("state", &state);
        Redirect { location: url.to_string(), cookies: vec![state_cookie] }
    }

    /// Finishes a Google login: checks the state and asks Google who the player is. The caller sets the account
    /// cookie, because connecting Google to a GitHub login keeps the GitHub cookie. It blocks on the network.
    pub fn google_finish(
        &self,
        google: &GoogleClient,
        headers: &HeaderMap,
        code: Option<&str>,
        state: Option<&str>,
        now: i64,
    ) -> Result<(GoogleSignIn, String), String> {
        let location = self.check_state(headers, state, now)?;
        let code = code.ok_or("Google sent no code")?;
        let redirect = format!("{}/api/auth/google/callback", self.config.origin);
        let body: Value = ureq::post(GOOGLE_TOKEN)
            .header("accept", "application/json")
            .send_form([
                ("code", code),
                ("client_id", google.client_id.as_str()),
                ("client_secret", google.client_secret.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
            ])
            .and_then(|mut response| response.body_mut().read_json())
            .map_err(|error| error.to_string())?;
        Ok((self.google_user_of(body.get("id_token"), &google.client_id, now)?, location))
    }

    /// The account of a One Tap sign-in: the page sends the ID token that Google gave it. It blocks on the network.
    /// Limit: no nonce, so a stolen ID token works until it expires (one hour). The X-Player header keeps other sites
    /// out. Revisit this if a token leak becomes possible, for example through logs.
    pub fn one_tap(&self, google: &GoogleClient, credential: &str, now: i64) -> Result<GoogleSignIn, String> {
        self.google_user_of(Some(&Value::from(credential)), &google.client_id, now)
    }

    fn google_key(&self, kid: &str, now: i64) -> Result<Option<RsaKey>, String> {
        let mut keys = self.google_keys.lock().expect("the Google keys lock is not poisoned");
        let cached = keys.as_ref().and_then(|(known, _)| known.get(kid).cloned());
        let age = keys.as_ref().map_or(i64::MAX, |(_, fetched)| now - fetched);
        if cached.is_some() && age < GOOGLE_KEYS_MS {
            return Ok(cached);
        }
        if cached.is_none() && age < GOOGLE_KEYS_RETRY_MS {
            return Ok(None);
        }
        let body: Value =
            ureq::get(GOOGLE_KEYS).call().and_then(|mut response| response.body_mut().read_json()).map_err(|error| error.to_string())?;
        let mut found = HashMap::new();
        for key in body.get("keys").and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some("RSA"), Some(n), Some(e)) = (
                key.get("kid").and_then(Value::as_str),
                key.get("kty").and_then(Value::as_str),
                key.get("n").and_then(Value::as_str),
                key.get("e").and_then(Value::as_str),
            ) else {
                continue;
            };
            if let (Ok(n), Ok(e)) = (URL_SAFE_NO_PAD.decode(n), URL_SAFE_NO_PAD.decode(e)) {
                found.insert(id.to_owned(), (n, e));
            }
        }
        if found.is_empty() {
            return Err("Google sent no signing keys".into());
        }
        let key = found.get(kid).cloned();
        *keys = Some((found, now));
        Ok(key)
    }

    /// The Google account of an ID token: Google signed it for our client, and it has not expired.
    fn google_user_of(&self, id_token: Option<&Value>, client_id: &str, now: i64) -> Result<GoogleSignIn, String> {
        let id_token = id_token.and_then(Value::as_str).ok_or("Google sent no ID token")?;
        let parts: Vec<&str> = id_token.split('.').collect();
        let [head, body, signature] = parts[..] else { return Err("the ID token is not a JWT".into()) };
        let header = json_part(head)?;
        let (Some("RS256"), Some(kid)) = (text(&header, "alg"), text(&header, "kid")) else {
            return Err("the ID token has an unknown signature".into());
        };
        let (n, e) = self.google_key(kid, now)?.ok_or("the ID token has an unknown key")?;
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| "the ID token has a wrong signature")?;
        ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
            .verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, format!("{head}.{body}").as_bytes(), &signature)
            .map_err(|_| "the ID token has a wrong signature")?;
        let claims = json_part(body)?;
        if text(&claims, "aud") != Some(client_id)
            || !GOOGLE_ISSUERS.iter().any(|issuer| claims.get("iss").and_then(Value::as_str) == Some(*issuer))
        {
            return Err("the ID token is for another app".into());
        }
        let expires = claims.get("exp").and_then(Value::as_f64).ok_or("the ID token expired")?;
        if expires * 1000.0 <= now as f64 {
            return Err("the ID token expired".into());
        }
        // Google documents the subject id as at most 255 ASCII characters.
        let subject =
            text(&claims, "sub").filter(|sub| !sub.is_empty() && sub.encode_utf16().count() <= 255).ok_or("the ID token has no subject")?;
        // The Google name as a custom name: the full name, else the first name. Another name shows a generated name.
        let name = claims.get("name").and_then(parse_custom_name).or_else(|| claims.get("given_name").and_then(parse_custom_name));
        // The photo without its size: avatarSrc in src/avatar.ts adds the size, as "=s<pixels>-c".
        let picture = text(&claims, "picture")
            .filter(|picture| picture.starts_with(GOOGLE_PICTURES))
            .map(|picture| picture.rsplit_once('=').map_or(picture, |(base, _)| base).to_owned());
        Ok(GoogleSignIn { google: subject.to_owned(), profile: GoogleProfile { name, picture } })
    }
}

/// The value of a cookie, as readCookie: the first part with this name, split at the first "=".
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=').unwrap_or((part.trim(), ""));
        (key == name).then(|| value.to_owned())
    })
}

pub fn cookie(name: &str, value: &str, max_age: i64, domain: Option<&str>, path: &str) -> String {
    let domain = domain.map(|domain| format!("; Domain={domain}")).unwrap_or_default();
    format!("{name}={value}; Path={path}{domain}; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax")
}

/// The GitHub logins that can read reports and moderate. GitHub logins ignore case.
const MAINTAINERS: [&str; 2] = ["yarden-zamir", "tomcohendev"];

pub fn is_maintainer(login: &str) -> bool {
    MAINTAINERS.contains(&login.to_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use serde_json::json;

    use super::*;

    fn auth() -> Auth {
        Auth::new(AuthConfig {
            client_id: "id".into(),
            client_secret: "secret".into(),
            secret: "0123456789abcdef0123456789abcdef".into(),
            origin: "https://tick3d.example".into(),
            cookie_domain: "tick3d.example".into(),
            google: None,
        })
    }

    fn with_cookie(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(&format!("other=1; {USER_COOKIE}={value}")).unwrap());
        headers
    }

    #[test]
    fn a_signed_cookie_names_its_account_until_it_expires() {
        let auth = auth();
        let github =
            auth.sign(&json!({ "id": 7, "login": "octo-cat", "avatar": "https://avatars.githubusercontent.com/u/7", "exp": 2000 }));
        let expected = Login::GitHub { id: 7, login: "octo-cat".into(), avatar: "https://avatars.githubusercontent.com/u/7".into() };
        assert_eq!(auth.user(&with_cookie(&github), 1000), Some(expected));
        assert_eq!(auth.user(&with_cookie(&github), 2000), None);
        let google = auth.sign(&json!({ "google": "123", "exp": 2000 }));
        assert_eq!(auth.user(&with_cookie(&google), 1000), Some(Login::Google { google: "123".into() }));
    }

    #[test]
    fn a_changed_or_foreign_cookie_names_nobody() {
        let auth = auth();
        let signed = auth.sign(&json!({ "google": "123", "exp": 2000 }));
        let (_, signature) = signed.split_once('.').unwrap();
        let forged = format!("{}.{signature}", URL_SAFE_NO_PAD.encode(r#"{"google":"999","exp":2000}"#));
        assert_eq!(auth.user(&with_cookie(&forged), 1000), None);
        let picture = auth.sign(&json!({ "id": 7, "login": "octo", "avatar": "https://example.com/a.png", "exp": 2000 }));
        assert_eq!(auth.user(&with_cookie(&picture), 1000), None);
    }

    /// A key and an ID token that Node signed once (crypto.sign with RSA-SHA256), so the test needs no network.
    const GOOGLE_N: &str = "r5p85Q2k6d6DyFzQlVdSUFepBFbA4MfDcmJbNHE158xvxtcLeuOA6KONU5VdCGrbg76mdRmqPS0ZI3fyhkGKzF115D1hsRqBdpVuXNDb17vY7vTzec6_RYgio5LnAq3JPQx0d7q4JY7AduE4H6KEV3DxkLSvfCQyv_9YBNL4x_9WhqY6x9X_CvS9MPROSnmmCjp63p4oRkEXGjy3ddO6cH58hslz4tBbdrvnR1ZMhwk9lN0SgGX9EcTWXZvwcetZAeIFnkpc5JMAKb8qyV8XfRdpGTfSAkkCnGWmINolU1reLX6FmF4cRu5HM5ZjVl6Z3AHobWXQRTfALCaf4oNEKw";
    const GOOGLE_TOKEN_SIGNED: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjbGllbnQtMSIsImlzcyI6Imh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbSIsImV4cCI6MjAwMDAwMDAwMCwic3ViIjoiMTIzNDU2Nzg5MCIsIm5hbWUiOiIgIEFuYSAgIE1hcsOtYSAiLCJwaWN0dXJlIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvcGhvdG89czk2LWMifQ.ICSxDFaLLTy7zV6amB-WZmppyfWS63xHrqjRM1ejGH7VTtkT2G-fmfY4E_dXYwanGEeDuBQIfFIQNMbz41SzYTzSyQ_ZBQ3AzBR7JafZPWszKrX6OL7A18ggAW6c718SiLZqASIAiG9YlTsMoRMhyLo8mFcC_Q89EIG48FHTXRfMTqLJ_JojiIpXhqt50CxxaeYBsHgsaamCChoneDfjhGcyW_tVcmlVUOUI33k0jyukzo6db5BLNOCB27JyvyvJzSJzQeKMvNqV_YtV5O_qAc8h0gIV7exowMKfm2a2MV9pEDHBmxzsfDP3ZXNOb2p0lhys5_fX4M6CvrlP9nirkQ";

    #[test]
    fn a_google_id_token_needs_the_signature_of_a_known_key() {
        let auth = auth();
        // The cache holds the key, fresh at the time of each check, so no check calls Google.
        let seed = |fetched: i64| {
            let key = (URL_SAFE_NO_PAD.decode(GOOGLE_N).unwrap(), URL_SAFE_NO_PAD.decode("AQAB").unwrap());
            *auth.google_keys.lock().unwrap() = Some((HashMap::from([("k1".to_owned(), key)]), fetched));
        };
        seed(0);
        let token = Value::from(GOOGLE_TOKEN_SIGNED);
        let user = auth.google_user_of(Some(&token), "client-1", 1000).unwrap();
        assert_eq!(user.google, "1234567890");
        assert_eq!(user.profile.name.as_deref(), Some("Ana María"));
        assert_eq!(user.profile.picture.as_deref(), Some("https://lh3.googleusercontent.com/a/photo"));
        assert_eq!(auth.google_user_of(Some(&token), "client-2", 1000).err().as_deref(), Some("the ID token is for another app"));
        seed(2_000_000_000_000);
        assert_eq!(auth.google_user_of(Some(&token), "client-1", 2_000_000_000_000).err().as_deref(), Some("the ID token expired"));
        seed(0);
        let (signed, _) = GOOGLE_TOKEN_SIGNED.rsplit_once('.').unwrap();
        let forged = Value::from(format!("{signed}.{}", URL_SAFE_NO_PAD.encode([0u8; 256])));
        assert_eq!(auth.google_user_of(Some(&forged), "client-1", 1000).err().as_deref(), Some("the ID token has a wrong signature"));
    }
}

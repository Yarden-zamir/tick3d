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

use crate::protocol::{GITHUB_PICTURES, is_github_login};

const USER_COOKIE: &str = "t3_user";

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
}

impl Auth {
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
        Auth {
            config: AuthConfig {
                client_id: "id".into(),
                client_secret: "secret".into(),
                secret: "0123456789abcdef0123456789abcdef".into(),
                origin: "https://tick3d.example".into(),
                cookie_domain: "tick3d.example".into(),
                google: None,
            },
        }
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
}

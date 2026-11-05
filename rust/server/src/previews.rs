//! The previews list (GET /api/previews): the open pull requests of the repository that have a live preview.
//!
//! The data comes from the public GitHub REST API without a token. GitHub allows 60 such calls per hour per address, and
//! production and every preview share the address of the VPS. So:
//! - only production calls GitHub. A preview server reads production's GET /api/previews and keeps it for RELAY_CACHE_MS;
//! - on production, the whole answer is cached for CACHE_MS, and one refresh serves every request that waits for it;
//! - the commits of a pull request are read again only when its head commit changes;
//! - when GitHub says that few calls are left, the server makes no call until the limit resets;
//! - on any GitHub failure, the server keeps the last good list and adds a note.
//!
//! "Live" means that the preview's /api/health answers { ok: true } now.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::App;
use crate::error::ApiResult;
use crate::protocol::{GITHUB_PICTURES, is_github_login, js_length, js_trim};
use crate::sessions::ok_json;
use crate::store::now_ms;

/// PREVIEWS_CACHE_MS and PREVIEWS_RELAY_CACHE_MS in contract/api-docs.ts.
const CACHE_MS: i64 = 180_000;
const RELAY_CACHE_MS: i64 = 15_000;
/// GitHub returns at most this many pull requests in one page, the most recently updated first.
const MAX_PULLS: usize = 30;
/// GitHub returns at most 100 commits in one page. A pull request with more shows the first 100 only.
const MAX_COMMITS: usize = 100;
const MAX_CONTRIBUTORS: usize = 20;
/// The server keeps this many GitHub calls of the hour for other uses.
const RATE_RESERVE: f64 = 5.0;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const GITHUB_TIMEOUT: Duration = Duration::from_secs(10);
/// Production reads GitHub and checks the previews, so its answer can take a few seconds.
const PRODUCTION_TIMEOUT: Duration = Duration::from_secs(20);
const PRODUCTION_ENVIRONMENT: &str = "prod";
const REPO_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";
/// PREVIEW_* in src/protocol.ts.
const DESCRIPTION_LENGTH: usize = 280;
const TOY_LABEL: &str = "Toys";
const MAX_IMAGES: usize = 8;
const IMAGE_ALT_LENGTH: usize = 200;
/// The page loads description images from GitHub only, so a description cannot make a player's browser call another site.
const IMAGE_SOURCES: [&str; 3] =
    ["https://raw.githubusercontent.com/", "https://github.com/user-attachments/assets/", "https://user-images.githubusercontent.com/"];
const CO_AUTHOR: &str = "co-authored-by:";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    GitHub,
    Production,
}

pub struct PreviewsConfig {
    /// owner/name of the GitHub repository.
    repo: String,
    /// Production's host; the previews live at its first label plus -pr-<n> (preview_host).
    domain: String,
    source: Source,
}

/// A local or LAN host sets neither PREVIEWS_REPO nor PREVIEWS_DOMAIN and has no previews.
/// Without KITSHN_ENVIRONMENT, every preview would call GitHub and use up the shared limit, so a missing value is an error.
pub fn previews_config_from_env() -> Result<Option<PreviewsConfig>, String> {
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let (repo, domain, environment) = (env("PREVIEWS_REPO"), env("PREVIEWS_DOMAIN"), env("KITSHN_ENVIRONMENT"));
    let (repo, domain) = match (repo, domain) {
        (None, None) => return Ok(None),
        (Some(repo), Some(domain)) => (repo, domain),
        _ => return Err("The previews list needs both PREVIEWS_REPO and PREVIEWS_DOMAIN".into()),
    };
    let environment = environment.ok_or("The previews list needs KITSHN_ENVIRONMENT to tell production from a preview")?;
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || !parts.iter().all(|part| !part.is_empty() && part.chars().all(|char| REPO_CHARS.contains(char))) {
        return Err("PREVIEWS_REPO must be owner/name".into());
    }
    let source = if environment == PRODUCTION_ENVIRONMENT { Source::GitHub } else { Source::Production };
    Ok(Some(PreviewsConfig { repo, domain, source }))
}

/// previewHost in src/protocol.ts: tick3d.yarden-zamir.com has the previews tick3d-pr-<n>.yarden-zamir.com.
fn preview_host(domain: &str, number: u64) -> String {
    match domain.split_once('.') {
        None => format!("{domain}-pr-{number}"),
        Some((first, rest)) => format!("{first}-pr-{number}.{rest}"),
    }
}

/// previewNumberOfHost in src/protocol.ts: the first label is pr-<n> or ends in -pr-<n>.
fn preview_number_of_host(host: &str) -> Option<u64> {
    let label = host.split('.').next().unwrap_or("");
    let at = label.rfind("pr-")?;
    if at > 0 && !label[..at].ends_with('-') {
        return None;
    }
    let digits = &label[at + 3..];
    if digits.is_empty() || !digits.chars().all(|char| char.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().filter(|number| *number > 0 && *number < 1 << 53)
}

fn is_image_source(src: &str) -> bool {
    IMAGE_SOURCES.iter().any(|prefix| src.starts_with(prefix))
}

// ---- The answer ----

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contributor {
    login: String,
    avatar: String,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewImage {
    src: String,
    alt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    number: u64,
    title: String,
    /// The first paragraph of the pull request body as plain text.
    description: String,
    /// The pull request on GitHub.
    url: String,
    preview_url: String,
    updated_at: u64,
    draft: bool,
    /// The author of the pull request and the commit authors, most commits first.
    contributors: Vec<Contributor>,
    /// A stacked pull request: the listed pull request whose head branch is its base branch.
    parent: Option<u64>,
    /// The pull request has the label TOY_LABEL: its preview also serves a toy at /toys/.
    toy: bool,
    images: Vec<PreviewImage>,
}

impl Preview {
    /// parsePreview in src/protocol.ts: the page puts the addresses in links, so each must go to the expected kind of site.
    /// Limit: the defaults of production servers from before stacked pull requests, toys and images are left out. Every
    /// production server sends these fields now.
    fn valid(&self) -> bool {
        let host = self.preview_url.strip_prefix("https://").map(|rest| rest.split('/').next().unwrap_or(""));
        self.number >= 1
            && self.parent != Some(self.number)
            && self.parent != Some(0)
            && js_length(&self.description) <= DESCRIPTION_LENGTH
            && self.url.starts_with("https://github.com/")
            && host.and_then(preview_number_of_host) == Some(self.number)
            && self.updated_at < 1 << 53
            && self.contributors.iter().all(|person| {
                person_of(&person.login, &person.avatar).is_some() && person.url == format!("https://github.com/{}", person.login)
            })
            && self.images.len() <= MAX_IMAGES
            && self.images.iter().all(|image| is_image_source(&image.src) && js_length(&image.alt) <= IMAGE_ALT_LENGTH)
    }
}

/// `main` is the production site. `error` says why the list is empty or old.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreviewsAnswer {
    main: Option<String>,
    previews: Vec<Preview>,
    error: Option<String>,
}

// ---- Reading the GitHub answers ----

/// A GitHub account that is a person: a GitHub login, and a picture from GitHub. A "[bot]" login is not a GitHub login.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Person {
    login: String,
    avatar: String,
}

fn person_of(login: &str, avatar: &str) -> Option<Person> {
    (is_github_login(login) && avatar.starts_with(GITHUB_PICTURES)).then(|| Person { login: login.to_owned(), avatar: avatar.to_owned() })
}

fn account_of(value: &Value) -> Option<Person> {
    let value = value.as_object()?;
    if value.get("type").and_then(Value::as_str) == Some("Bot") {
        return None;
    }
    person_of(value.get("login")?.as_str()?, value.get("avatar_url")?.as_str()?)
}

/// `branch` and `base` are GitHub labels (owner:branch), so a fork branch never matches a branch of this repository.
#[derive(Debug)]
struct Pull {
    number: u64,
    title: String,
    body: String,
    url: String,
    updated_at: u64,
    draft: bool,
    head: String,
    branch: String,
    base: String,
    author: Option<Person>,
    labels: Vec<String>,
}

/// One pull request from GET /repos/{repo}/pulls, or None for an entry that is not as documented.
fn parse_pull(value: &Value) -> Option<Pull> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let number = value.get("number")?.as_u64().filter(|number| *number >= 1)?;
    let url = text(value.get("html_url")).filter(|url| url.starts_with("https://github.com/"))?;
    let updated = chrono::DateTime::parse_from_rfc3339(value.get("updated_at")?.as_str()?).ok()?;
    let labels = value
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| labels.iter().filter_map(|label| text(label.get("name"))).collect())
        .unwrap_or_default();
    Some(Pull {
        number,
        title: text(value.get("title"))?,
        body: text(value.get("body")).unwrap_or_default(),
        url,
        updated_at: u64::try_from(updated.timestamp_millis()).ok()?,
        draft: value.get("draft") == Some(&Value::Bool(true)),
        head: text(value.get("head")?.get("sha"))?,
        branch: text(value.get("head")?.get("label"))?,
        base: text(value.get("base")?.get("label"))?,
        author: value.get("user").and_then(account_of),
        labels,
    })
}

/// The noreply address of a GitHub account: <id>+<login>@users.noreply.github.com.
/// Limit: the older form without the id has no avatar address, so it is left out. Revisit when such contributors show up.
fn co_author_of(line: &str) -> Option<Person> {
    let start = line.find('<')?;
    let end = line.find("@users.noreply.github.com>").filter(|end| *end > start)?;
    let (id, login) = line[start + 1..end].split_once('+')?;
    if id.is_empty() || !id.chars().all(|char| char.is_ascii_digit()) || login.contains('+') {
        return None;
    }
    person_of(login, &format!("https://avatars.githubusercontent.com/u/{id}?v=4"))
}

/// The people behind one commit from GET /repos/{repo}/pulls/{n}/commits: its GitHub author and its co-authors.
fn commit_people(value: &Value) -> Vec<Person> {
    let mut people: Vec<Person> = value.get("author").and_then(account_of).into_iter().collect();
    if let Some(message) = value.get("commit").and_then(|commit| commit.get("message")).and_then(Value::as_str) {
        people.extend(message.split('\n').filter(|line| js_trim(line).to_lowercase().starts_with(CO_AUTHOR)).filter_map(co_author_of));
    }
    people
}

/// The author of the pull request and the people behind its commits, once each, most commits first.
/// A tie keeps the first seen order, so the author of the pull request comes first.
fn merge_contributors(author: Option<&Person>, commits: &[Vec<Person>]) -> Vec<Contributor> {
    let mut counted: Vec<(String, Person, usize)> =
        author.map(|author| (author.login.to_lowercase(), author.clone(), 0)).into_iter().collect();
    for people in commits {
        // A commit counts once for each person, also when a trailer names its author again.
        let mut seen = HashSet::new();
        for person in people {
            let key = person.login.to_lowercase();
            if !seen.insert(key.clone()) {
                continue;
            }
            match counted.iter_mut().find(|(known, ..)| *known == key) {
                Some((.., commits)) => *commits += 1,
                None => counted.push((key, person.clone(), 1)),
            }
        }
    }
    counted.sort_by_key(|(.., commits)| std::cmp::Reverse(*commits));
    counted
        .into_iter()
        .take(MAX_CONTRIBUTORS)
        .map(|(_, Person { login, avatar }, _)| Contributor { url: format!("https://github.com/{login}"), login, avatar })
        .collect()
}

/// The body without HTML comments, such as the hints of a pull request template, and without carriage returns.
fn without_comments(body: &str) -> String {
    let mut text = body.replace('\r', "");
    while let Some(start) = text.find("<!--") {
        let rest = text[start..].find("-->").map_or(String::new(), |end| text[start + end + 3..].to_owned());
        text = format!("{}{rest}", &text[..start]);
    }
    text
}

fn strip_line_marks(line: &str) -> &str {
    for mark in ["- [ ] ", "- [x] ", "> ", "- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(mark) {
            return strip_line_marks(rest);
        }
    }
    match line.find(". ") {
        Some(dot) if (1..=3).contains(&dot) && line[..dot].chars().all(|char| char.is_ascii_digit()) => &line[dot + 2..],
        _ => line,
    }
}

/// Links and images keep their text only. A string method cannot match the nested brackets simply.
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").expect("a valid regex"));

/// The first paragraph of a pull request body as plain text, at most DESCRIPTION_LENGTH UTF-16 units.
/// Limit: it removes the common Markdown only (headings, lists, quotes, code fences, links, bold and code marks).
/// Revisit when a description shows raw Markdown that matters.
fn summary_of(body: &str) -> String {
    let text = without_comments(body);
    let mut lines: Vec<&str> = Vec::new();
    let mut fence = false;
    for raw in text.split('\n') {
        let line = js_trim(raw);
        if line.starts_with("```") {
            fence = !fence;
            continue;
        }
        if fence || line.starts_with('#') || line.is_empty() {
            if !lines.is_empty() {
                break;
            }
            continue;
        }
        lines.push(strip_line_marks(line));
    }
    let joined =
        LINK.replace_all(&lines.join(" "), "$1").replace("**", "").replace("__", "").replace("~~", "").replace('`', "").replace('\t', " ");
    let plain = joined.split(' ').filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    if js_length(&plain) <= DESCRIPTION_LENGTH {
        return plain;
    }
    // Limit: the cut counts UTF-16 units as JavaScript does. A cut inside a surrogate pair gives U+FFFD, where Node keeps half the pair.
    let cut: Vec<u16> = plain.encode_utf16().take(DESCRIPTION_LENGTH - 1).collect();
    let space = cut.iter().rposition(|unit| *unit == u16::from(b' '));
    let kept = match space {
        Some(space) if space > DESCRIPTION_LENGTH / 2 => &cut[..space],
        _ => &cut[..],
    };
    format!("{}…", String::from_utf16_lossy(kept))
}

/// Markdown images, ![alt](src "title"), and HTML images, <img src="…" alt="…">. A string method cannot find the brackets
/// and the attributes in any order simply, so these use patterns.
static MARKDOWN_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)"#).expect("a valid regex"));
static HTML_IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<img\b[^>]*>").expect("a valid regex"));
static HTML_SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\ssrc\s*=\s*("([^"]*)"|'([^']*)')"#).expect("a valid regex"));
static HTML_ALT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\salt\s*=\s*("([^"]*)"|'([^']*)')"#).expect("a valid regex"));

fn attribute_of(tag: &str, pattern: &Regex) -> String {
    pattern.captures(tag).and_then(|found| found.get(2).or_else(|| found.get(3))).map_or(String::new(), |value| value.as_str().to_owned())
}

/// The images of a pull request body, in their order: only images from IMAGE_SOURCES, each once, at most MAX_IMAGES.
/// Limit: an image inside a code fence counts too. Revisit when a description shows Markdown examples of images.
fn images_of(body: &str) -> Vec<PreviewImage> {
    let text = without_comments(body);
    let mut found: Vec<(usize, String, String)> = MARKDOWN_IMAGE
        .captures_iter(&text)
        .map(|image| (image.get(0).expect("a match").start(), image[2].to_owned(), image[1].to_owned()))
        .collect();
    found.extend(
        HTML_IMAGE.find_iter(&text).map(|tag| (tag.start(), attribute_of(tag.as_str(), &HTML_SRC), attribute_of(tag.as_str(), &HTML_ALT))),
    );
    found.sort_by_key(|(at, ..)| *at);
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|(_, src, _)| is_image_source(src) && seen.insert(src.clone()))
        .take(MAX_IMAGES)
        .map(|(_, src, alt)| PreviewImage {
            src,
            alt: String::from_utf16_lossy(&js_trim(&alt).encode_utf16().take(IMAGE_ALT_LENGTH).collect::<Vec<_>>()),
        })
        .collect()
}

// ---- The list ----

#[derive(Default)]
struct ListState {
    /// The contributors of each pull request, by number, with the head commit that they belong to.
    contributors: HashMap<u64, (String, Vec<Contributor>)>,
    last: Option<Vec<Preview>>,
    current: Option<PreviewsAnswer>,
    fresh_until: i64,
    /// No GitHub call before this time: the hourly limit is (nearly) used up.
    paused_until: i64,
}

pub struct Previews {
    config: std::sync::Arc<PreviewsConfig>,
    agent: ureq::Agent,
    /// A tokio lock: requests during a refresh wait for that one refresh.
    state: tokio::sync::Mutex<ListState>,
}

impl Previews {
    pub fn new(config: PreviewsConfig) -> Previews {
        let agent = ureq::Agent::config_builder().http_status_as_error(false).build().new_agent();
        Previews { config: std::sync::Arc::new(config), agent, state: tokio::sync::Mutex::default() }
    }

    /// The list, at most one cache period old.
    pub async fn list(&self) -> PreviewsAnswer {
        let mut state = self.state.lock().await;
        if let Some(current) = state.current.as_ref().filter(|_| now_ms() < state.fresh_until) {
            return current.clone();
        }
        let (config, agent, mut taken) = (self.config.clone(), self.agent.clone(), std::mem::take(&mut *state));
        let refreshed = tokio::task::spawn_blocking(move || {
            let answer = match config.source {
                Source::GitHub => taken.load_from_github(&config, &agent),
                Source::Production => taken.load_from_production(&config, &agent),
            };
            taken.current = Some(answer);
            // A failure also waits one cache period, so an outage does not cost a call per request.
            taken.fresh_until = now_ms() + if config.source == Source::GitHub { CACHE_MS } else { RELAY_CACHE_MS };
            taken
        })
        .await
        .expect("a previews refresh does not panic");
        *state = refreshed;
        state.current.clone().expect("a refresh sets the list")
    }
}

fn main_of(config: &PreviewsConfig) -> String {
    format!("https://{}", config.domain)
}

fn get(agent: &ureq::Agent, url: &str, timeout: Duration) -> Result<ureq::http::Response<ureq::Body>, String> {
    agent
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "tick3d")
        .header("x-github-api-version", "2022-11-28")
        .config()
        .timeout_global(Some(timeout))
        .build()
        .call()
        .map_err(|error| error.to_string())
}

impl ListState {
    fn github(&mut self, config: &PreviewsConfig, agent: &ureq::Agent, path: &str) -> Result<Value, String> {
        if now_ms() < self.paused_until {
            return Err("the GitHub limit is used up".into());
        }
        let url = format!("https://api.github.com/repos/{}{path}", config.repo);
        let mut response = get(agent, &url, GITHUB_TIMEOUT).map_err(|error| format!("GitHub is out of reach: {error}"))?;
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
        if let Some(remaining) = header("x-ratelimit-remaining")
            && remaining.trim().parse::<f64>().is_ok_and(|remaining| remaining <= RATE_RESERVE)
        {
            // The reset time is in epoch seconds. Without a usable value, wait one cache period.
            let reset = header("x-ratelimit-reset")
                .and_then(|reset| reset.trim().parse::<f64>().ok())
                .filter(|reset| reset.is_finite() && *reset > 0.0);
            self.paused_until = reset.map_or(now_ms() + CACHE_MS, |reset| (reset * 1000.0) as i64);
        }
        if !response.status().is_success() {
            return Err(format!("GitHub answered {} for {path}", response.status().as_u16()));
        }
        response.body_mut().read_json().map_err(|_| format!("GitHub sent no JSON for {path}"))
    }

    fn contributors_of(
        &mut self,
        config: &PreviewsConfig,
        agent: &ureq::Agent,
        pull: &Pull,
        fresh: &mut HashMap<u64, (String, Vec<Contributor>)>,
    ) -> Vec<Contributor> {
        if let Some(cached) = self.contributors.get(&pull.number).filter(|(head, _)| *head == pull.head) {
            fresh.insert(pull.number, cached.clone());
            return cached.1.clone();
        }
        let commits =
            self.github(config, agent, &format!("/pulls/{}/commits?per_page={MAX_COMMITS}", pull.number)).and_then(
                |commits| match commits {
                    Value::Array(commits) => Ok(commits),
                    _ => Err(format!("GitHub sent no commit list for #{}", pull.number)),
                },
            );
        match commits {
            Ok(commits) => {
                let people: Vec<Vec<Person>> = commits.iter().take(MAX_COMMITS).map(commit_people).collect();
                let contributors = merge_contributors(pull.author.as_ref(), &people);
                fresh.insert(pull.number, (pull.head.clone(), contributors.clone()));
                contributors
            }
            Err(error) => {
                // The author alone, and no cache entry, so the next refresh tries the commits again.
                eprintln!("previews: {error}");
                merge_contributors(pull.author.as_ref(), &[])
            }
        }
    }

    fn refresh(&mut self, config: &PreviewsConfig, agent: &ureq::Agent) -> Result<Vec<Preview>, String> {
        let Value::Array(answer) =
            self.github(config, agent, &format!("/pulls?state=open&sort=updated&direction=desc&per_page={MAX_PULLS}"))?
        else {
            return Err("GitHub sent no pull request list".into());
        };
        let pulls: Vec<Pull> = answer.iter().take(MAX_PULLS).filter_map(parse_pull).collect();
        let preview_url = |number: u64| format!("https://{}", preview_host(&config.domain, number));
        // The health checks run at once: each waits up to HEALTH_TIMEOUT.
        let live: Vec<bool> = std::thread::scope(|scope| {
            let checks: Vec<_> = pulls.iter().map(|pull| scope.spawn(|| is_live(agent, &preview_url(pull.number)))).collect();
            checks.into_iter().map(|check| check.join().expect("a health check does not panic")).collect()
        });
        let listed: Vec<&Pull> = pulls.iter().zip(live).filter_map(|(pull, live)| live.then_some(pull)).collect();
        // Limit: the commit lists load one after the other, where Node loads them at once. Most heads are cached.
        // Revisit when a cold refresh with many new heads gets slow.
        let mut fresh = HashMap::new();
        let previews = listed
            .iter()
            .map(|pull| Preview {
                number: pull.number,
                title: pull.title.clone(),
                description: summary_of(&pull.body),
                url: pull.url.clone(),
                preview_url: preview_url(pull.number),
                updated_at: pull.updated_at,
                draft: pull.draft,
                contributors: self.contributors_of(config, agent, pull, &mut fresh),
                parent: listed.iter().find(|other| other.branch == pull.base).map(|other| other.number),
                toy: pull.labels.iter().any(|label| label == TOY_LABEL),
                images: images_of(&pull.body),
            })
            .collect();
        // Closed pull requests drop out of the cache here.
        self.contributors = fresh;
        Ok(previews)
    }

    fn load_from_github(&mut self, config: &PreviewsConfig, agent: &ureq::Agent) -> PreviewsAnswer {
        let main = Some(main_of(config));
        match self.refresh(config, agent) {
            Ok(previews) => {
                self.last = Some(previews.clone());
                PreviewsAnswer { main, previews, error: None }
            }
            Err(error) => {
                eprintln!("previews: {error}");
                let note = if self.last.is_none() {
                    "GitHub did not answer. Try again later."
                } else {
                    "GitHub did not answer. The list can be old."
                };
                PreviewsAnswer { main, previews: self.last.clone().unwrap_or_default(), error: Some(note.into()) }
            }
        }
    }

    /// A preview server: production's list as it is, so the page sees the same list and the same note everywhere.
    fn load_from_production(&mut self, config: &PreviewsConfig, agent: &ureq::Agent) -> PreviewsAnswer {
        let main = main_of(config);
        let answer = get(agent, &format!("{main}/api/previews"), PRODUCTION_TIMEOUT).and_then(|mut response| {
            if !response.status().is_success() {
                return Err(format!("production answered {}", response.status().as_u16()));
            }
            let answer: PreviewsAnswer = response.body_mut().read_json().map_err(|error| error.to_string())?;
            let valid = answer.main.as_ref().is_none_or(|main| main.starts_with("https://")) && answer.previews.iter().all(Preview::valid);
            if valid { Ok(answer) } else { Err("invalid answer from /api/previews".into()) }
        });
        match answer {
            Ok(answer) => {
                self.last = Some(answer.previews.clone());
                PreviewsAnswer { main: Some(main), ..answer }
            }
            Err(error) => {
                eprintln!("previews: production did not answer: {error}");
                let note = if self.last.is_none() {
                    "The production site did not answer. Try again later."
                } else {
                    "The production site did not answer. The list can be old."
                };
                PreviewsAnswer { main: Some(main), previews: self.last.clone().unwrap_or_default(), error: Some(note.into()) }
            }
        }
    }
}

fn is_live(agent: &ureq::Agent, preview_url: &str) -> bool {
    let Ok(mut response) = get(agent, &format!("{preview_url}/api/health"), HEALTH_TIMEOUT) else { return false };
    response.status().is_success() && response.body_mut().read_json::<Value>().is_ok_and(|body| body.get("ok") == Some(&Value::Bool(true)))
}

/// Cached in Previews, so a flood of requests costs no extra GitHub calls and needs no limiter.
pub async fn previews(State(app): State<App>) -> ApiResult<Response> {
    let answer = match &app.previews {
        None => PreviewsAnswer { main: None, previews: Vec::new(), error: Some("This server has no previews.".into()) },
        Some(previews) => previews.list().await,
    };
    Ok(ok_json(StatusCode::OK, &answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries_keep_the_first_paragraph_as_plain_text() {
        let body = "<!-- agent -->\r\n## Title\n- [x] **Bold** [link](https://x.y) and `code`\n1. next\n\nSecond paragraph";
        assert_eq!(summary_of(body), "Bold link and code next");
        let long = "word ".repeat(100);
        let summary = summary_of(&long);
        assert!(summary.ends_with('…') && js_length(&summary) <= DESCRIPTION_LENGTH);
    }

    #[test]
    fn images_come_from_github_in_order_once() {
        let body = r#"<img alt="b" src="https://raw.githubusercontent.com/b.png"> ![a](https://github.com/user-attachments/assets/a "t")
            ![x](https://evil.example/x.png) <IMG SRC='https://raw.githubusercontent.com/b.png'>"#;
        let images = images_of(body);
        assert_eq!(
            images,
            [
                PreviewImage { src: "https://raw.githubusercontent.com/b.png".into(), alt: "b".into() },
                PreviewImage { src: "https://github.com/user-attachments/assets/a".into(), alt: "a".into() },
            ]
        );
    }

    #[test]
    fn contributors_count_each_commit_once_per_person() {
        let commit = |login: &str, message: &str| json!({ "author": { "login": login, "avatar_url": "https://avatars.githubusercontent.com/u/1", "type": "User" }, "commit": { "message": message } });
        let commits = [
            commit_people(&commit(
                "bob",
                "fix\n\nCo-authored-by: Ann <2+ann@users.noreply.github.com>\nco-authored-by: Bob <1+bob@users.noreply.github.com>",
            )),
            commit_people(&commit("bob", "more")),
            commit_people(&commit("dependabot[bot]", "bump")),
        ];
        let author = Person { login: "ann".into(), avatar: "https://avatars.githubusercontent.com/u/2".into() };
        let logins: Vec<String> = merge_contributors(Some(&author), &commits).into_iter().map(|person| person.login).collect();
        assert_eq!(logins, ["bob", "ann"]);
    }

    #[test]
    fn preview_hosts_round_trip() {
        assert_eq!(preview_host("tick3d.yarden-zamir.com", 12), "tick3d-pr-12.yarden-zamir.com");
        assert_eq!(preview_number_of_host("tick3d-pr-12.yarden-zamir.com"), Some(12));
        assert_eq!(preview_number_of_host("pr-3.example.com"), Some(3));
        assert_eq!(preview_number_of_host("tickpr-3.example.com"), None);
    }
}

//! The checks of request bodies and headers, as in src/protocol.ts. Each parser takes the parsed JSON body and
//! returns None for a body that the TypeScript parser refuses, so the route answers with the same 400.
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use tick3d_core::clock::{NO_LIMIT, TimeControl};
use tick3d_core::game::Cell;
use tick3d_core::playoff::{MAX_ROUND_MS, PLAYOFF_TARGETS, PlayoffRequest, PresetId};
use tick3d_core::session::{MoveRequest, NAME_MAX_LENGTH, SeatAction, SessionUpdate};

use crate::ids::{ACCOUNT_TOKEN_PREFIX, PERSON_ID_LENGTH};

pub const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LENGTH: usize = 4;
const TOKEN_CHARS: &str = "abcdefghijklmnopqrstuvwxyz0123456789-";
const WATCHER_ID_LENGTH: usize = 16;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A token is a crypto.randomUUID() kept in the browser. It proves which seat a browser holds.
/// No client may send an account token as its own: a GitHub id is public.
pub fn as_player_token(input: &str) -> Option<String> {
    let valid = (16..=64).contains(&input.len())
        && !input.starts_with(ACCOUNT_TOKEN_PREFIX)
        && input.chars().all(|char| TOKEN_CHARS.contains(char));
    valid.then(|| input.to_owned())
}

/// A session code: 4 characters of CODE_ALPHABET, in any case, with white space around.
pub fn normalize_code(input: &str) -> Option<String> {
    let code = js_trim(input).to_uppercase();
    let valid = code.chars().count() == CODE_LENGTH && code.chars().all(|char| CODE_ALPHABET.contains(char));
    valid.then_some(code)
}

/// JavaScript `trim()`: the JavaScript white space differs from Rust in U+0085 and U+FEFF.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// JavaScript white space (`\s`): the Rust white space without U+0085, plus U+FEFF.
fn is_js_space(char: char) -> bool {
    char == '\u{FEFF}' || (char.is_whitespace() && char != '\u{85}')
}

/// The length of a text as JavaScript counts it: UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn normalize_name(input: &Value) -> Option<String> {
    let name = js_trim(input.as_str()?);
    (1..=NAME_MAX_LENGTH).contains(&js_length(name)).then(|| name.to_owned())
}

/// A JSON number that is a whole number from 0 to `max` (Number.isInteger in JavaScript also takes 2.0).
pub fn whole(value: &Value, max: u64) -> Option<u64> {
    let number = value.as_number()?;
    let whole = match number.as_u64() {
        Some(whole) => whole,
        None => {
            let float = number.as_f64()?;
            if float.fract() != 0.0 || !(0.0..=max as f64).contains(&float) {
                return None;
            }
            float as u64
        }
    };
    (whole <= max).then_some(whole)
}

fn has_only_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

fn parse_limit(value: Option<&Value>, min: u64, max: u64) -> Option<Option<u32>> {
    match value? {
        Value::Null => Some(None),
        limit => {
            let limit = whole(limit, max)?;
            (limit >= min).then(|| Some(u32::try_from(limit).expect("a limit fits in u32")))
        }
    }
}

/// parseClock in src/clock.ts: both keys are required, each a whole number in its range or null.
pub fn parse_clock(value: &Value) -> Option<TimeControl> {
    let value = value.as_object()?;
    let per_move = parse_limit(value.get("perMove"), 3, 600)?;
    let per_game = parse_limit(value.get("perGame"), 30, 7200)?;
    Some(TimeControl { per_move, per_game })
}

/// The body of POST /api/sessions. The clock is optional and defaults to no limit.
pub struct NewSession {
    pub name: String,
    pub clock: TimeControl,
}

pub fn parse_new_session(value: &Value) -> Option<NewSession> {
    let value = value.as_object()?;
    let name = normalize_name(value.get("name").unwrap_or(&Value::Null))?;
    let clock = match value.get("clock") {
        None => NO_LIMIT,
        Some(clock) => parse_clock(clock)?,
    };
    Some(NewSession { name, clock })
}

pub fn parse_move_request(value: &Value) -> Option<MoveRequest> {
    let value = value.as_object()?;
    let count = |key: &str| value.get(key).and_then(|n| whole(n, u64::MAX)).map(|n| usize::try_from(n).expect("a count fits in usize"));
    let cell = whole(value.get("cell")?, 63)?;
    Some(MoveRequest {
        game: count("game")?,
        move_count: count("moveCount")?,
        cell: Cell::try_from(u8::try_from(cell).expect("a cell fits in u8")).ok()?,
    })
}

/// Refuses an unknown field, a wrong type, an invalid name, or an empty update.
pub fn parse_session_update(value: &Value) -> Option<SessionUpdate> {
    let value = value.as_object()?;
    let known = ["name", "hideBoard", "hideHistory", "hideCoordinates", "clock", "fixedSeats", "watcherChat"];
    if value.is_empty() || !has_only_keys(value, &known) {
        return None;
    }
    // A present key with a wrong type refuses the whole update.
    let flag = |key: &str| -> Option<Option<bool>> {
        match value.get(key) {
            None => Some(None),
            Some(flag) => flag.as_bool().map(Some),
        }
    };
    Some(SessionUpdate {
        name: match value.get("name") {
            None => None,
            Some(name) => Some(normalize_name(name)?),
        },
        clock: match value.get("clock") {
            None => None,
            Some(clock) => Some(parse_clock(clock)?),
        },
        fixed_seats: flag("fixedSeats")?,
        watcher_chat: flag("watcherChat")?,
        hide_board: flag("hideBoard")?,
        hide_history: flag("hideHistory")?,
        hide_coordinates: flag("hideCoordinates")?,
    })
}

fn is_watcher_id(value: &Value) -> Option<String> {
    let id = value.as_str()?;
    let valid = id.len() == WATCHER_ID_LENGTH && id.chars().all(|char| char.is_ascii_hexdigit() && !char.is_ascii_uppercase());
    valid.then(|| id.to_owned())
}

/// The body of POST /api/sessions/{code}/seats. Refuses an unknown action, a missing or extra watcher, and extra fields.
pub fn parse_seat_action(value: &Value) -> Option<SeatAction> {
    let value = value.as_object()?;
    let watcher = || -> Option<String> {
        if !has_only_keys(value, &["action", "watcher"]) {
            return None;
        }
        is_watcher_id(value.get("watcher")?)
    };
    let plain = |action: SeatAction| has_only_keys(value, &["action"]).then_some(action);
    match value.get("action")?.as_str()? {
        "give" => Some(SeatAction::Give { watcher: watcher()? }),
        "seat" => Some(SeatAction::Seat { watcher: watcher()? }),
        "replace" => Some(SeatAction::Replace { watcher: watcher()? }),
        "swap" => plain(SeatAction::Swap),
        "leave" => plain(SeatAction::Leave),
        "unseat" => plain(SeatAction::Unseat),
        "undo" => plain(SeatAction::Undo),
        _ => None,
    }
}

/// The body of POST /api/sessions/{code}/seats/answer: `accept`.
pub fn parse_seat_answer(value: &Value) -> Option<bool> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["accept"]) {
        return None;
    }
    value.get("accept")?.as_bool()
}

/// parsePlayoffRequest in src/practice/playoff.ts. Extra fields are allowed there, so here too.
pub fn parse_playoff_request(value: &Value) -> Option<PlayoffRequest> {
    let value = value.as_object()?;
    let get = |key: &str, max: u64| value.get(key).and_then(|n| whole(n, max));
    let id = || get("id", MAX_SAFE_INTEGER);
    match value.get("action")?.as_str()? {
        "start" => {
            let preset = PresetId::parse(value.get("preset")?.as_str()?)?;
            let seed = u32::try_from(get("seed", u64::from(u32::MAX))?).expect("the seed fits in u32");
            Some(PlayoffRequest::Start { preset, seed })
        }
        "join" => Some(PlayoffRequest::Join { id: id()? }),
        "leave" => Some(PlayoffRequest::Leave { id: id()? }),
        "hit" => Some(PlayoffRequest::Hit {
            id: id()?,
            index: usize::try_from(get("index", (PLAYOFF_TARGETS - 1) as u64)?).expect("an index fits in usize"),
            ms: u32::try_from(get("ms", MAX_ROUND_MS as u64)?).expect("ms fits in u32"),
        }),
        _ => None,
    }
}

// ---- Practice ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PracticeMode {
    Targets,
    Echo,
}

impl PracticeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PracticeMode::Targets => "targets",
            PracticeMode::Echo => "echo",
        }
    }

    pub fn parse(text: &str) -> Option<PracticeMode> {
        [PracticeMode::Targets, PracticeMode::Echo].into_iter().find(|mode| mode.as_str() == text)
    }

    /// ROUNDS in src/practice/practice.ts.
    fn rounds(self) -> usize {
        match self {
            PracticeMode::Targets => PLAYOFF_TARGETS,
            PracticeMode::Echo => 8,
        }
    }
}

/// ECHO_POINTS in src/practice/practice.ts: the points of one perfect echo round.
const ECHO_POINTS: u64 = 100;

/// A finished run of the practice room (POST /api/practice/runs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PracticeRun {
    pub id: String,
    pub mode: PracticeMode,
    pub preset: PresetId,
    pub round_ms: Vec<u32>,
    pub score: u32,
}

/// parsePracticeRun: an id of 8 to 64 letters, digits or "-", one time per round, and a score that the mode can give.
/// Extra fields are allowed there, so here too.
pub fn parse_practice_run(value: &Value) -> Option<PracticeRun> {
    let value = value.as_object()?;
    let mode = PracticeMode::parse(value.get("mode")?.as_str()?)?;
    let preset = PresetId::parse(value.get("preset")?.as_str()?)?;
    let id = value.get("id")?.as_str()?;
    if !(8..=64).contains(&id.len()) || !id.chars().all(|char| char.is_ascii_alphanumeric() || char == '-') {
        return None;
    }
    let rounds = value.get("roundMs")?.as_array()?;
    if rounds.len() != mode.rounds() {
        return None;
    }
    let round_ms = rounds
        .iter()
        .map(|ms| whole(ms, MAX_ROUND_MS as u64).map(|ms| u32::try_from(ms).expect("a round time fits in u32")))
        .collect::<Option<Vec<_>>>()?;
    let max_score = match mode {
        PracticeMode::Echo => ECHO_POINTS * mode.rounds() as u64,
        PracticeMode::Targets => mode.rounds() as u64,
    };
    let score = whole(value.get("score")?, max_score)?;
    if mode == PracticeMode::Targets && score != max_score {
        return None;
    }
    Some(PracticeRun { id: id.to_owned(), mode, preset, round_ms, score: u32::try_from(score).expect("a score fits in u32") })
}

// ---- Accounts ----

pub const CUSTOM_NAME_MIN_LENGTH: usize = 2;
pub const CUSTOM_NAME_MAX_LENGTH: usize = 24;
/// Letters of any script with their marks, digits, spaces, "-" and "_". A regex is the simplest way to match the
/// Unicode categories, as in src/protocol.ts.
static CUSTOM_NAME_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{M}\p{Nd} _-]+$").expect("a valid regex"));
static CUSTOM_NAME_LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{Nd}]").expect("a valid regex"));

/// parseCustomName: trims, collapses inner white space, and needs 2 to 24 allowed characters with a letter or a digit.
pub fn parse_custom_name(value: &Value) -> Option<String> {
    let name = js_trim(value.as_str()?).split(is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let length = name.chars().count();
    let valid = (CUSTOM_NAME_MIN_LENGTH..=CUSTOM_NAME_MAX_LENGTH).contains(&length)
        && CUSTOM_NAME_CHARS.is_match(&name)
        && CUSTOM_NAME_LETTER.is_match(&name);
    valid.then_some(name)
}

const GITHUB_LOGIN_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";

pub fn is_github_login(login: &str) -> bool {
    (1..=39).contains(&login.len()) && login.chars().all(|char| GITHUB_LOGIN_CHARS.contains(char))
}

pub fn parse_person_id(value: &str) -> Option<String> {
    let valid = value.len() == PERSON_ID_LENGTH && value.chars().all(|char| char.is_ascii_digit() || ('a'..='f').contains(&char));
    valid.then(|| value.to_owned())
}

/// The picture of an account (PUT /api/me/avatar): the picture of the login that made the account, or a new generated one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AvatarPicture {
    Github,
    Google,
    Generated,
}

impl AvatarPicture {
    pub fn as_str(self) -> &'static str {
        match self {
            AvatarPicture::Github => "github",
            AvatarPicture::Google => "google",
            AvatarPicture::Generated => "generated",
        }
    }
}

pub fn parse_avatar_request(value: &Value) -> Option<AvatarPicture> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["picture"]) {
        return None;
    }
    match value.get("picture")?.as_str()? {
        "github" => Some(AvatarPicture::Github),
        "google" => Some(AvatarPicture::Google),
        "generated" => Some(AvatarPicture::Generated),
        _ => None,
    }
}

/// The body of PUT /api/me/stats-privacy: `{ "private": bool }`.
pub fn parse_stats_privacy(value: &Value) -> Option<bool> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["private"]) {
        return None;
    }
    value.get("private")?.as_bool()
}

/// The body of PUT /api/me/blocks/{person}: the name that the caller saw, 1 to NAME_MAX_LENGTH UTF-16 units.
pub fn parse_block_request(value: &Value) -> Option<String> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["name"]) {
        return None;
    }
    let name = value.get("name")?.as_str()?;
    (1..=NAME_MAX_LENGTH).contains(&js_length(name)).then(|| name.to_owned())
}

/// Pictures come from GitHub and Google only, so a page never loads an image from an address that a player chose.
pub const GITHUB_PICTURES: &str = "https://avatars.githubusercontent.com/";

/// `Number(text)` in JavaScript for a query or path value: an empty text is 0, and white space around is fine.
/// Limit: hex, octal and binary texts ("0x10") give None here, and JavaScript reads them. Revisit if a client sends one.
pub fn js_number(text: &str) -> Option<f64> {
    let text = js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    // Rust also reads "inf" and "nan", which JavaScript does not. Neither passes a whole-number check.
    text.parse::<f64>().ok()
}

/// A JavaScript safe integer of at least `min`, from `Number(text)`.
pub fn js_safe_integer(text: &str, min: i64) -> Option<i64> {
    let number = js_number(text)?;
    let valid = number.fract() == 0.0 && number >= min as f64 && number <= MAX_SAFE_INTEGER as f64;
    valid.then_some(number as i64)
}

pub const REPORT_NOTE_MAX_LENGTH: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReportTarget {
    Message(u64),
    Person(String),
}

/// Where a report points: one chat message or person of an online session, or a person of the stats page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReportPlace {
    Session { code: String, target: ReportTarget },
    StatsPage { person: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportRequest {
    pub reason: &'static str,
    pub note: Option<String>,
    pub place: ReportPlace,
}

/// The body of POST /api/reports: { code?, message | person, reason, note? }. Exactly one target, and a message needs a code.
pub fn parse_report_request(value: &Value) -> Option<ReportRequest> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["code", "message", "person", "reason", "note"]) {
        return None;
    }
    let code = match value.get("code") {
        None => None,
        Some(code) => Some(normalize_code(code.as_str()?)?),
    };
    let reason =
        ["spam", "abuse", "name", "other"].into_iter().find(|reason| value.get("reason").and_then(Value::as_str) == Some(*reason))?;
    let note = match value.get("note") {
        None | Some(Value::Null) => "",
        Some(note) => js_trim(note.as_str()?),
    };
    if js_length(note) > REPORT_NOTE_MAX_LENGTH {
        return None;
    }
    let note = (!note.is_empty()).then(|| note.to_owned());
    let place = match (value.get("message"), value.get("person")) {
        (Some(message), None) => {
            ReportPlace::Session { code: code?, target: ReportTarget::Message(whole(message, MAX_SAFE_INTEGER).filter(|id| *id >= 1)?) }
        }
        (None, Some(person)) => {
            let person = parse_person_id(person.as_str()?)?;
            match code {
                Some(code) => ReportPlace::Session { code, target: ReportTarget::Person(person) },
                None => ReportPlace::StatsPage { person },
            }
        }
        _ => return None,
    };
    Some(ReportRequest { reason, note, place })
}

const VERSION_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";

/// isVersion: 1 to 64 characters of VERSION_CHARS.
pub fn is_version(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.chars().all(|char| VERSION_CHARS.contains(char))
}

/// A page fault that a page reports (POST /api/events).
pub struct ClientEvent {
    pub kind: &'static str,
    pub message: String,
    pub version: String,
}

const EVENT_MESSAGE_MAX_LENGTH: usize = 300;

/// parseClientEvent: a known kind, a message of 1 to 300 UTF-16 units, and a version.
pub fn parse_client_event(value: &Value) -> Option<ClientEvent> {
    let value = value.as_object()?;
    if !has_only_keys(value, &["kind", "message", "version"]) {
        return None;
    }
    let kind = ["error", "rejection", "refusals"].into_iter().find(|kind| value.get("kind").and_then(Value::as_str) == Some(*kind))?;
    let version = value.get("version")?.as_str().filter(|version| is_version(version))?;
    let message = value.get("message")?.as_str().filter(|message| (1..=EVENT_MESSAGE_MAX_LENGTH).contains(&js_length(message)))?;
    Some(ClientEvent { kind, message: message.to_owned(), version: version.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_need_one_target_and_a_code_for_a_message() {
        let person = "0123456789abcdef";
        let stats = parse_report_request(&json!({ "person": person, "reason": "spam", "note": "  " })).unwrap();
        assert_eq!(stats.place, ReportPlace::StatsPage { person: person.into() });
        assert_eq!(stats.note, None);
        let message = parse_report_request(&json!({ "code": "abcd", "message": 3, "reason": "abuse" })).unwrap();
        assert_eq!(message.place, ReportPlace::Session { code: "ABCD".into(), target: ReportTarget::Message(3) });
        assert_eq!(parse_report_request(&json!({ "message": 3, "reason": "abuse" })), None);
        assert_eq!(parse_report_request(&json!({ "code": "ABCD", "message": 3, "person": person, "reason": "abuse" })), None);
        assert_eq!(parse_report_request(&json!({ "code": null, "person": person, "reason": "abuse" })), None);
        assert_eq!(parse_report_request(&json!({ "person": person, "reason": "abuse", "note": "x".repeat(201) })), None);
    }

    #[test]
    fn custom_names_follow_parse_custom_name() {
        assert_eq!(parse_custom_name(&json!("  Ana \t  María ")), Some("Ana María".into()));
        assert_eq!(parse_custom_name(&json!("דנה_1")), Some("דנה_1".into()));
        assert_eq!(parse_custom_name(&json!("--")), None, "a name needs a letter or a digit");
        assert_eq!(parse_custom_name(&json!("a")), None);
        assert_eq!(parse_custom_name(&json!("bad!")), None);
        assert_eq!(parse_custom_name(&json!("x".repeat(25))), None);
    }

    #[test]
    fn practice_runs_need_a_score_that_the_mode_can_give() {
        let run = |mode: &str, rounds: usize, score: u64| {
            parse_practice_run(
                &json!({ "id": "run-12345678", "mode": mode, "preset": "easy", "roundMs": vec![1500; rounds], "score": score }),
            )
        };
        assert!(run("targets", 10, 10).is_some());
        assert!(run("targets", 10, 9).is_none());
        assert!(run("targets", 8, 10).is_none());
        assert!(run("echo", 8, 800).is_some());
        assert!(run("echo", 8, 801).is_none());
    }

    #[test]
    fn whole_numbers_follow_javascript() {
        assert_eq!(whole(&json!(2.0), 10), Some(2));
        assert_eq!(whole(&json!(2.5), 10), None);
        assert_eq!(whole(&json!(-1), 10), None);
        assert_eq!(whole(&json!(11), 10), None);
        assert_eq!(whole(&json!("2"), 10), None);
    }

    #[test]
    fn a_clock_needs_both_limits() {
        assert_eq!(parse_clock(&json!({ "perMove": 10, "perGame": null })), Some(TimeControl { per_move: Some(10), per_game: None }));
        assert_eq!(parse_clock(&json!({ "perMove": 10 })), None);
        assert_eq!(parse_clock(&json!({ "perMove": 2, "perGame": null })), None);
    }

    #[test]
    fn updates_refuse_unknown_and_empty_bodies() {
        assert!(parse_session_update(&json!({})).is_none());
        assert!(parse_session_update(&json!({ "colour": "red" })).is_none());
        assert!(parse_session_update(&json!({ "hideBoard": "yes" })).is_none());
        assert_eq!(parse_session_update(&json!({ "hideBoard": true })).and_then(|update| update.hide_board), Some(true));
    }

    #[test]
    fn seat_actions_need_exactly_their_fields() {
        assert_eq!(parse_seat_action(&json!({ "action": "swap" })), Some(SeatAction::Swap));
        assert!(parse_seat_action(&json!({ "action": "swap", "watcher": "0123456789abcdef" })).is_none());
        assert!(parse_seat_action(&json!({ "action": "give" })).is_none());
        assert!(parse_seat_action(&json!({ "action": "give", "watcher": "0123456789ABCDEF" })).is_none());
    }

    #[test]
    fn tokens_and_codes() {
        assert!(as_player_token("0123456789abcdef").is_some());
        assert!(as_player_token("account-0000000000000001").is_none());
        assert!(as_player_token("short").is_none());
        assert_eq!(normalize_code(" ab2c "), Some("AB2C".to_owned()));
        assert_eq!(normalize_code("AB1C"), None);
    }
}

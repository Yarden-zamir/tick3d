//! The checks of request bodies and headers, as in src/protocol.ts. Each parser takes the parsed JSON body and
//! returns None for a body that the TypeScript parser refuses, so the route answers with the same 400.
use serde_json::{Map, Value};
use tick3d_core::clock::{NO_LIMIT, TimeControl};
use tick3d_core::game::Cell;
use tick3d_core::playoff::{MAX_ROUND_MS, PLAYOFF_TARGETS, PlayoffRequest, PresetId};
use tick3d_core::session::{MoveRequest, NAME_MAX_LENGTH, SeatAction, SessionUpdate};

use crate::ids::ACCOUNT_TOKEN_PREFIX;

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
    text.trim_matches(|char: char| char == '\u{FEFF}' || (char.is_whitespace() && char != '\u{85}'))
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
            let preset = match value.get("preset")?.as_str()? {
                "easy" => PresetId::Easy,
                "normal" => PresetId::Normal,
                "hard" => PresetId::Hard,
                _ => return None,
            };
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

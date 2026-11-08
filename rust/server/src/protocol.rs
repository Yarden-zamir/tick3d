//! The checks of request bodies and headers, as in src/protocol.ts. Each parser takes the parsed JSON body and
//! returns None for a body that the TypeScript parser refuses, so the route answers with the same 400.
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use tick3d_core::clock::{NO_LIMIT, TimeControl};
use tick3d_core::game::{Cell, EpochMs, Player, Status, replay};
use tick3d_core::playoff::{MAX_ROUND_MS, PLAYOFF_TARGETS, PlayoffRequest, PresetId};
use tick3d_core::session::{GameRecord, MatchOptions, MoveRequest, NAME_MAX_LENGTH, SeatAction, SessionUpdate};

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

// ---- Game links ----

pub const DEVICE_GAME_ID_LENGTH: usize = 8;
/// Game numbers above this are not real: a session of a million games has never happened.
const MAX_GAME_NUMBER: u64 = 1_000_000;

/// A game id: a device id (8 code characters) or an online id ("<CODE>-<n>").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameId {
    Device(String),
    Online { code: String, index: usize },
}

impl GameId {
    pub fn text(&self) -> String {
        match self {
            GameId::Device(id) => id.clone(),
            GameId::Online { code, index } => format!("{code}-{}", index + 1),
        }
    }
}

/// parseGameId: either form in any case, trimmed and in upper case. `String(n) === number` refuses leading zeros and signs.
pub fn parse_game_id(input: &str) -> Option<GameId> {
    let id = js_trim(input).to_uppercase();
    if id.chars().count() == DEVICE_GAME_ID_LENGTH && id.chars().all(|char| CODE_ALPHABET.contains(char)) {
        return Some(GameId::Device(id));
    }
    let (code, number) = id.split_once('-')?;
    if number.contains('-') || normalize_code(code).as_deref() != Some(code) {
        return None;
    }
    let n = number.parse::<u64>().ok().filter(|n| (1..=MAX_GAME_NUMBER).contains(n) && n.to_string() == number)?;
    Some(GameId::Online { code: code.to_owned(), index: usize::try_from(n - 1).expect("a game number fits in usize") })
}

/// parseDeviceGameId: only the exact form that newGameId makes.
fn parse_device_game_id(input: &str) -> Option<String> {
    match parse_game_id(input)? {
        GameId::Device(id) if id == input => Some(id),
        _ => None,
    }
}

// ---- Games and metrics ----

/// Easy, Medium, Hard: the order of DIFFICULTIES, from the easiest level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    Medium,
    Hard,
}

impl Difficulty {
    pub fn parse(text: &str) -> Option<Difficulty> {
        [Difficulty::Easy, Difficulty::Medium, Difficulty::Hard].into_iter().find(|level| level.as_str() == text)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Difficulty::Easy => "easy",
            Difficulty::Medium => "medium",
            Difficulty::Hard => "hard",
        }
    }
}

/// The mode of a finished game. A session document is always online; a result can be any of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameMode {
    Computer,
    Friend,
    Online,
    Nearby,
}

/// isGameRecord, then the replay of toGame: None for a record that does not replay. Extra keys are allowed there, so here too.
pub fn parse_game_record(value: &Value) -> Option<(GameRecord, Status)> {
    let value = value.as_object()?;
    let moves = value.get("moves")?.as_array()?;
    let times = value.get("times")?.as_array()?;
    if moves.len() > 64 || times.len() != moves.len() {
        return None;
    }
    let moves = moves.iter().map(|cell| Cell::try_from(u8::try_from(whole(cell, 63)?).ok()?).ok()).collect::<Option<Vec<Cell>>>()?;
    let times = times.iter().map(|at| whole(at, MAX_SAFE_INTEGER).map(|at| at as EpochMs)).collect::<Option<Vec<EpochMs>>>()?;
    let timed_out = value.get("timedOut")?.as_bool()?;
    let abandoned = match value.get("abandoned") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return None,
    };
    let clock = parse_clock(value.get("clock")?)?;
    let game = replay(&moves, Player::X, Some(&times), clock).ok()?;
    // timeOut and abandon throw for a game that is over: the record then does not parse. A game that timed out is over,
    // so it cannot also be abandoned (in Rust, abandon() on it panics and stops the server).
    if ((timed_out || abandoned) && !game.is_playing()) || (timed_out && abandoned) {
        return None;
    }
    let ended = if timed_out { game.time_out() } else { game };
    let status = if abandoned { ended.abandon().status } else { ended.status };
    Some((GameRecord { moves, times, clock, timed_out, abandoned }, status))
}

/// hasResult: a won, timed out or drawn game.
pub fn has_result(status: &Status) -> bool {
    matches!(status, Status::Won { .. } | Status::Timeout { .. } | Status::Draw)
}

/// parseMatchOptions: a sender or a stored value from before hideCoordinates has no such field, and it reads as false.
pub fn parse_match_options(value: &Value) -> Option<MatchOptions> {
    let value = value.as_object()?;
    let hide_coordinates = match value.get("hideCoordinates") {
        None | Some(Value::Null) => false,
        Some(flag) => flag.as_bool()?,
    };
    Some(MatchOptions {
        hide_board: value.get("hideBoard")?.as_bool()?,
        hide_history: value.get("hideHistory")?.as_bool()?,
        hide_coordinates,
    })
}

/// The lists and ranges of parseMetrics, from TypeScript (rust/server/contract.json).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricLists {
    views: Vec<String>,
    layouts: Vec<String>,
    themes: Vec<String>,
    refusals: Vec<String>,
    tuning_fields: Vec<TuningField>,
}

impl MetricLists {
    /// REFUSALS in src/protocol.ts, in its order.
    pub fn refusals(&self) -> &[String] {
        &self.refusals
    }
}

#[derive(serde::Deserialize)]
struct TuningField {
    path: Vec<String>,
    min: f64,
    max: f64,
    step: f64,
}

/// Size limits. A game has at most 64 moves, so no honest count comes near these.
const MAX_COUNT: u64 = 10_000;
const MAX_THINK_MS: f64 = 120_000.0;
const DEVICE_KINDS: [&str; 3] = ["phone", "tablet", "computer"];
const METRIC_KEYS: [&str; 12] =
    ["device", "view", "layout", "theme", "input", "refused", "undos", "thinkMs", "offline", "version", "tuning", "nearby"];

fn one_of<'a>(options: &[String], value: Option<&'a Value>) -> Option<&'a str> {
    value?.as_str().filter(|text| options.iter().any(|option| option == text))
}

/// isTuning, then parseTuning: every field holds a number in its range (a whole number for a whole step).
/// The answer holds only the fields, so extra keys drop out.
fn parse_tuning(lists: &MetricLists, value: &Value) -> Option<Value> {
    let mut tuning = Value::Object(Map::new());
    for field in &lists.tuning_fields {
        let found = field.path.iter().try_fold(value, |at, key| at.as_object()?.get(key))?;
        let number = found.as_f64().filter(|number| number.is_finite() && (field.min..=field.max).contains(number))?;
        if field.step.fract() == 0.0 && number.fract() != 0.0 {
            return None;
        }
        let (last, parents) = field.path.split_last().expect("a tuning path has a key");
        let mut at = &mut tuning;
        for key in parents {
            at = at.as_object_mut().expect("a tuning group is an object").entry(key.clone()).or_insert_with(|| Value::Object(Map::new()));
        }
        at.as_object_mut().expect("a tuning group is an object").insert(last.clone(), found.clone());
    }
    Some(tuning)
}

/// parseMetrics: refuses an unknown key, a missing key, a wrong type or a value out of range. The answer is the
/// checked object that the server stores.
pub fn parse_metrics(lists: &MetricLists, value: &Value) -> Option<Value> {
    let value = value.as_object()?;
    if !has_only_keys(value, &METRIC_KEYS) || !METRIC_KEYS.iter().all(|key| value.contains_key(*key)) {
        return None;
    }
    let device = value.get("device")?.as_str().filter(|device| DEVICE_KINDS.contains(device))?;
    let view = one_of(&lists.views, value.get("view"))?;
    let layout = one_of(&lists.layouts, value.get("layout"))?;
    let theme = one_of(&lists.themes, value.get("theme"))?;
    let input = value.get("input")?.as_object().filter(|input| has_only_keys(input, &["board", "keypad", "voice"]))?;
    let board = whole(input.get("board")?, MAX_COUNT)?;
    let keypad = whole(input.get("keypad")?, MAX_COUNT)?;
    // Limit: a page from before the voice count sends none, and a result that waits on such a device must still upload,
    // so a missing count is 0. Remove this when no result from before the count can wait anymore.
    let voice = match input.get("voice") {
        None | Some(Value::Null) => 0,
        Some(voice) => whole(voice, MAX_COUNT)?,
    };
    if voice > keypad {
        return None;
    }
    let mut refused = Map::new();
    for (key, count) in value.get("refused")?.as_object()? {
        if !lists.refusals.contains(key) {
            return None;
        }
        refused.insert(key.clone(), Value::from(whole(count, MAX_COUNT)?));
    }
    let undos = whole(value.get("undos")?, MAX_COUNT)?;
    let offline = value.get("offline")?.as_bool()?;
    let version = value.get("version")?.as_str().filter(|version| is_version(version))?;
    let think = value.get("thinkMs")?.as_array().filter(|times| times.len() <= 64)?;
    if !think.iter().all(|time| time.as_f64().is_some_and(|time| time.is_finite() && (0.0..=MAX_THINK_MS).contains(&time))) {
        return None;
    }
    let tuning = match value.get("tuning")? {
        Value::Null => Value::Null,
        tuning => parse_tuning(lists, tuning)?,
    };
    let nearby = match value.get("nearby")? {
        Value::Null => Value::Null,
        nearby => {
            let nearby = nearby.as_object().filter(|nearby| has_only_keys(nearby, &["role", "other"]))?;
            let role = nearby.get("role")?.as_str().filter(|role| ["host", "guest"].contains(role))?;
            let other = match nearby.get("other") {
                Some(Value::Null) => Value::Null,
                other => Value::from(other?.as_str().filter(|other| DEVICE_KINDS.contains(other))?),
            };
            serde_json::json!({ "role": role, "other": other })
        }
    };
    Some(serde_json::json!({
        "device": device, "view": view, "layout": layout, "theme": theme,
        "input": { "board": board, "keypad": keypad, "voice": voice },
        "refused": refused, "undos": undos, "thinkMs": think, "offline": offline, "version": version,
        "tuning": tuning, "nearby": nearby,
    }))
}

// ---- Results ----

/// A finished computer, friend or Nearby game, sent by the device that played it. `id` holds the player token, so it
/// never leaves the server. `guest` is the player token of the guest of a Nearby host.
#[derive(Clone, Debug)]
pub struct ResultUpload {
    pub id: String,
    pub mode: GameMode,
    pub game: GameRecord,
    /// The seat of this device's player. None for a friend game, where one device plays both seats.
    pub you: Option<Player>,
    pub difficulty: Option<Difficulty>,
    pub finished_at: i64,
    pub public_id: Option<String>,
    pub options: MatchOptions,
    pub tuned: bool,
    pub metrics: Option<Value>,
    pub guest: Option<String>,
}

/// One upload carries at most this many results (RESULTS_PER_UPLOAD).
pub const RESULTS_PER_UPLOAD: usize = 100;
const RESULT_ID_CHARS: &str = "abcdefghijklmnopqrstuvwxyz0123456789-";
/// A result can finish at most this far in the future, to allow for a device clock that runs fast.
const FUTURE_SLACK_MS: i64 = 86_400_000;
const RESULT_KEYS: [&str; 11] =
    ["id", "mode", "game", "you", "difficulty", "finishedAt", "publicId", "options", "tuned", "metrics", "guest"];

fn player_of(value: &Value) -> Option<Option<Player>> {
    match value {
        Value::Null => Some(None),
        Value::String(seat) if seat == "X" => Some(Some(Player::X)),
        Value::String(seat) if seat == "O" => Some(Some(Player::O)),
        _ => None,
    }
}

/// parseResultUpload. `now` is the time of the reader. A device version before game links sends no publicId, options,
/// tuned or metrics, and a version before generated names sends no guest: those get their defaults, so its waiting
/// results still upload.
pub fn parse_result_upload(lists: &MetricLists, value: &Value, now: i64) -> Option<ResultUpload> {
    let value = value.as_object().filter(|value| has_only_keys(value, &RESULT_KEYS))?;
    let id = value.get("id")?.as_str()?;
    if !(16..=64).contains(&id.len()) || !id.chars().all(|char| RESULT_ID_CHARS.contains(char)) {
        return None;
    }
    let mode = match value.get("mode")?.as_str()? {
        "computer" => GameMode::Computer,
        "friend" => GameMode::Friend,
        "nearby" => GameMode::Nearby,
        _ => return None,
    };
    let (game, status) = parse_game_record(value.get("game")?)?;
    if !has_result(&status) {
        return None;
    }
    let you = player_of(value.get("you")?)?;
    if (mode == GameMode::Friend) != you.is_none() {
        return None;
    }
    let difficulty = match value.get("difficulty")? {
        Value::Null => None,
        level => Some(Difficulty::parse(level.as_str()?)?),
    };
    if (mode == GameMode::Computer) != difficulty.is_some() {
        return None;
    }
    let finished_at = whole(value.get("finishedAt")?, MAX_SAFE_INTEGER)? as i64;
    if finished_at == 0 || finished_at > now.saturating_add(FUTURE_SLACK_MS) {
        return None;
    }
    let public_id = match value.get("publicId") {
        None | Some(Value::Null) => None,
        Some(id) => Some(parse_device_game_id(id.as_str()?)?),
    };
    let options = match value.get("options") {
        None | Some(Value::Null) => MatchOptions::default(),
        Some(options) => parse_match_options(options)?,
    };
    let tuned = match value.get("tuned") {
        None | Some(Value::Null) => false,
        Some(tuned) => tuned.as_bool()?,
    };
    if tuned && mode != GameMode::Computer {
        return None;
    }
    let metrics = match value.get("metrics") {
        None | Some(Value::Null) => None,
        Some(metrics) => Some(parse_metrics(lists, metrics)?),
    };
    let guest = match value.get("guest") {
        None | Some(Value::Null) => None,
        Some(guest) => Some(as_player_token(guest.as_str()?)?),
    };
    if guest.is_some() && (mode != GameMode::Nearby || you.is_none()) {
        return None;
    }
    Some(ResultUpload { id: id.to_owned(), mode, game, you, difficulty, finished_at, public_id, options, tuned, metrics, guest })
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

// ---- Tester codes ----

pub const TESTER_NAME_MAX_LENGTH: usize = 40;
const EMAIL_MAX_LENGTH: usize = 254;
static TESTER_NAME_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{M}\p{Nd} _.'-]+$").expect("a valid regex"));

/// parseTesterName in src/share/codes.ts: 1 to 40 characters after a trim, the inner spaces joined to one, with a letter or a digit.
pub fn parse_tester_name(text: &str) -> Option<String> {
    let name = js_trim(text).split(is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let valid = (1..=TESTER_NAME_MAX_LENGTH).contains(&name.chars().count())
        && TESTER_NAME_CHARS.is_match(&name)
        && CUSTOM_NAME_LETTER.is_match(&name);
    valid.then_some(name)
}

/// parseEmail in src/share/codes.ts: one "@", a name before it, and a domain with a dot after it.
/// Limit: it accepts some addresses that cannot receive mail. The maintainer reads each one by hand.
fn parse_email(text: &str) -> Option<String> {
    let email = js_trim(text);
    if js_length(email) > EMAIL_MAX_LENGTH || email.chars().any(is_js_space) {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    let valid =
        !local.is_empty() && !domain.contains('@') && domain.split('.').count() >= 2 && domain.split('.').all(|label| !label.is_empty());
    valid.then(|| email.to_owned())
}

/// The body of a tester code claim. `by` is the person id of the inviter, or None.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimRequest {
    pub email: String,
    pub name: String,
    pub by: Option<String>,
}

/// parseClaimRequest: a missing or null `by` is a claim without an invite. Another `by` must be a person id.
pub fn parse_claim_request(value: &Value) -> Option<ClaimRequest> {
    let value = value.as_object()?;
    let email = parse_email(value.get("email")?.as_str()?)?;
    let name = parse_tester_name(value.get("name")?.as_str()?)?;
    let by = match value.get("by") {
        None | Some(Value::Null) => None,
        Some(by) => Some(parse_person_id(by.as_str()?)?),
    };
    Some(ClaimRequest { email, name, by })
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

    #[test]
    fn refuses_a_record_that_both_timed_out_and_was_abandoned() {
        // A game that timed out has ended, so it cannot also be abandoned. Before the fix this panicked in abandon().
        let record = serde_json::json!({ "moves": [], "times": [], "clock": { "perMove": 10, "perGame": null }, "timedOut": true, "abandoned": true });
        assert!(parse_game_record(&record).is_none());
        let timed_out = serde_json::json!({ "moves": [0], "times": [1], "clock": { "perMove": 10, "perGame": null }, "timedOut": true });
        assert!(parse_game_record(&timed_out).is_some());
    }

    #[test]
    fn reads_the_stats_filters_as_the_page_writes_them() {
        let filter = parse_stats_filter(Some("scope=mine&range=7d&mode=computer&level=hard")).expect("a valid filter");
        assert_eq!(
            (filter.scope, filter.range, filter.mode, filter.level),
            (StatsScope::Mine, StatsRange::Week, Some(GameMode::Computer), Some(Difficulty::Hard))
        );
        assert_eq!(parse_stats_filter(None).map(|filter| filter.range), Some(StatsRange::All));
        let person = "person=0123456789abcdef";
        for refused in
            ["range=7d&range=30d", "mode=online&level=easy", "scope=mine&person=0123456789abcdef", "scope=", "other=1", "level=Hard"]
        {
            assert_eq!(parse_stats_filter(Some(refused)), None, "{refused}");
        }
        assert!(parse_stats_filter(Some(person)).is_some());
        assert_eq!(parse_leaderboard_filter(Some(person)), None);
        assert_eq!(parse_leaderboard_filter(Some("scope=mine")), None);
    }
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
    fn claims_need_an_email_shape_and_a_name() {
        let claim = |email: &str, name: &str| parse_claim_request(&json!({ "email": email, "name": name }));
        assert_eq!(claim(" a@b.c ", "  Ann   Lee ").map(|claim| (claim.email, claim.name)), Some(("a@b.c".into(), "Ann Lee".into())));
        assert!(claim("a@b", "Ann").is_none());
        assert!(claim("a@@b.c", "Ann").is_none());
        assert!(claim("a b@c.d", "Ann").is_none());
        assert!(claim("a@b..c", "Ann").is_none());
        assert!(claim("a@b.c", "...").is_none());
        assert!(parse_claim_request(&json!({ "email": "a@b.c", "name": "Ann", "by": "nope" })).is_none());
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

// ---- Stats filters ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatsScope {
    Everyone,
    Mine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum StatsRange {
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "all")]
    All,
}

impl StatsRange {
    /// RANGE_DAYS in src/protocol.ts. None for all time.
    pub fn days(self) -> Option<i64> {
        match self {
            StatsRange::Week => Some(7),
            StatsRange::Month => Some(30),
            StatsRange::All => None,
        }
    }
}

impl GameMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GameMode::Computer => "computer",
            GameMode::Friend => "friend",
            GameMode::Online => "online",
            GameMode::Nearby => "nearby",
        }
    }
}

/// The filters of the stats page (StatsFilter in src/protocol.ts). `person` goes with the everyone scope only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StatsFilter {
    pub scope: StatsScope,
    pub range: StatsRange,
    pub mode: Option<GameMode>,
    pub level: Option<Difficulty>,
    pub person: Option<String>,
}

pub const STATS_FILTER_ERROR: &str = "Unknown stats filter. scope: everyone or mine. range: 7d, 30d, all. mode: computer, friend, online, nearby. level: easy, medium, hard, only with the computer mode or no mode. person: a person id of 16 hex characters, not with scope mine. Each key at most once.";
pub const LEADERBOARD_FILTER_ERROR: &str = "Unknown leaderboard filter. range: 7d, 30d, all. mode: computer, friend, online, nearby. level: easy, medium, hard, only with the computer mode or no mode. Each key at most once.";

/// parseStatsFilter in src/protocol.ts. Refuses an unknown key, a repeated key, an unknown or empty value, a level with a
/// mode other than computer, and a person with the mine scope. `query` is the raw query of the address.
pub fn parse_stats_filter(query: Option<&str>) -> Option<StatsFilter> {
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes()).into_owned().collect();
    let mut filter = StatsFilter { scope: StatsScope::Everyone, range: StatsRange::All, mode: None, level: None, person: None };
    let mut seen = Vec::new();
    for (key, value) in &pairs {
        if seen.contains(&key.as_str()) {
            return None;
        }
        seen.push(key.as_str());
        match key.as_str() {
            "scope" => filter.scope = [StatsScope::Everyone, StatsScope::Mine].into_iter().find(|scope| json_name(scope) == *value)?,
            "range" => {
                filter.range =
                    [StatsRange::Week, StatsRange::Month, StatsRange::All].into_iter().find(|range| json_name(range) == *value)?
            }
            "mode" => {
                filter.mode = Some(
                    [GameMode::Computer, GameMode::Friend, GameMode::Online, GameMode::Nearby]
                        .into_iter()
                        .find(|mode| mode.as_str() == value)?,
                )
            }
            "level" => filter.level = Some(Difficulty::parse(value)?),
            "person" => filter.person = Some(parse_person_id(value)?),
            _ => return None,
        }
    }
    let level_without_computer = filter.level.is_some() && filter.mode.is_some_and(|mode| mode != GameMode::Computer);
    if level_without_computer || (filter.person.is_some() && filter.scope == StatsScope::Mine) {
        return None;
    }
    Some(filter)
}

/// The filter of GET /api/leaderboard: the stats filter without a scope and a person.
pub fn parse_leaderboard_filter(query: Option<&str>) -> Option<StatsFilter> {
    parse_stats_filter(query).filter(|filter| filter.scope == StatsScope::Everyone && filter.person.is_none())
}

/// The JSON text of a unit enum value, such as "7d".
fn json_name(value: &impl Serialize) -> String {
    serde_json::to_value(value).ok().and_then(|value| value.as_str().map(str::to_owned)).expect("a unit enum serializes to a text")
}

// ---- Releases ----

/// MAX_RELEASE_NAME in src/release.ts, in UTF-16 units as JavaScript counts them.
const MAX_RELEASE_NAME: usize = 200;

/// The page bundle that one deploy built (Release in src/release.ts). The build writes release.json.
#[derive(Debug, PartialEq, Eq)]
pub struct Release {
    /// The page script file name, as the metrics version carries it.
    pub version: String,
    pub name: String,
    /// The commit time of the build.
    pub at: i64,
}

/// parseRelease in src/release.ts. A bad release file is a build fault, so the caller stops the start.
pub fn parse_release(value: &Value) -> Result<Release, &'static str> {
    let value = value.as_object().ok_or("release: not an object")?;
    let version = value.get("version").and_then(Value::as_str).filter(|version| is_version(version)).ok_or("release: bad version")?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && name.encode_utf16().count() <= MAX_RELEASE_NAME)
        .ok_or("release: bad name")?;
    let at = value.get("at").and_then(|at| whole(at, MAX_SAFE_INTEGER)).ok_or("release: bad time")?;
    Ok(Release { version: version.to_owned(), name: name.to_owned(), at: i64::try_from(at).expect("a safe integer fits in i64") })
}

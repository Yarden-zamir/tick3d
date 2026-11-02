// Runs the shared rule cases of src/session/rule-cases.json with the Rust rules. The TypeScript rules
// made the file (src/session/rule-cases.ts), so each result must give the same JSON.
// Each step runs on the document of the previous Rust step, not on the stored one, so a difference
// shows at the first step that differs.
use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};
use tick3d_core::clock::{NO_LIMIT, TimeControl};
use tick3d_core::game::{Cell, LINES, Line, PerPlayer, Player, line_kind, replay};
use tick3d_core::names::name_of;
use tick3d_core::playoff::PlayoffRequest;
use tick3d_core::session::{
    self, Audience, Identity, MoveRequest, OpenWatcher, SeatAction, SessionDoc, SessionError, SessionUpdate, ViewContext,
};

#[derive(Deserialize)]
struct Cases {
    sessions: Vec<SessionCase>,
    replays: Vec<ReplayCase>,
    lines: Vec<LineCase>,
    names: Vec<NameCase>,
}

#[derive(Deserialize)]
struct SessionCase {
    name: String,
    create: Create,
    start: Value,
    steps: Vec<Value>,
}

#[derive(Deserialize)]
struct Create {
    name: String,
    clock: TimeControl,
    seats: PerPlayer<Option<String>>,
}

#[derive(Deserialize)]
struct ReplayCase {
    moves: Vec<Cell>,
    first: Player,
    result: Value,
}

#[derive(Deserialize)]
struct LineCase {
    line: Line,
    kind: Value,
}

#[derive(Deserialize)]
struct NameCase {
    token: String,
    name: String,
}

#[derive(Deserialize)]
struct CaseAudience {
    presence: PerPlayer<bool>,
    watchers: Vec<OpenWatcher>,
    names: HashMap<String, String>,
    persons: HashMap<String, Option<String>>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Join { identity: Vec<String>, token: String },
    Move { identity: Vec<String>, request: MoveRequest, now: i64 },
    NewGame { identity: Vec<String> },
    Update { identity: Vec<String>, changes: SessionUpdate },
    Lock { identity: Vec<String> },
    Chat { identity: Vec<String>, text: String, now: i64, author: Option<String>, watchers: Vec<OpenWatcher> },
    Playoff { identity: Vec<String>, request: PlayoffRequest, now: i64 },
    Seat { identity: Vec<String>, request: SeatAction, watchers: Vec<OpenWatcher>, now: i64 },
    AnswerSeat { identity: Vec<String>, accept: bool, watchers: Vec<OpenWatcher>, now: i64 },
    Settle { now: i64 },
    AbandonLive {},
    View { identity: Vec<String>, code: String, version: u64, now: i64, audience: CaseAudience },
}

fn error_json(error: &SessionError) -> Value {
    json!({ "error": { "status": error.status as u16, "message": error.message, "code": error.code } })
}

fn doc_json(result: &Result<SessionDoc, SessionError>) -> Value {
    match result {
        Ok(doc) => json!({ "doc": doc }),
        Err(error) => error_json(error),
    }
}

/// Applies one action. Returns the result as JSON, and the next document when the action changed it.
fn apply(doc: &SessionDoc, action: Action) -> (Value, Option<SessionDoc>) {
    let set = |tokens: Vec<String>| -> Identity { tokens.into_iter().collect() };
    let result = match action {
        Action::Join { identity, token } => session::join(doc, &set(identity), &token),
        Action::Move { identity, request, now } => session::play_move(doc, &set(identity), &request, now),
        Action::NewGame { identity } => session::new_game(doc, &set(identity)),
        Action::Update { identity, changes } => session::update(doc, &set(identity), &changes),
        Action::Lock { identity } => session::lock(doc, &set(identity)),
        Action::Chat { identity, text, now, author, watchers } => {
            session::chat(doc, &set(identity), &text, now, author.as_deref(), &watchers)
        }
        Action::Playoff { identity, request, now } => session::playoff(doc, &set(identity), request, now),
        Action::Seat { identity, request, watchers, now } => session::seat(doc, &set(identity), &request, &watchers, now),
        Action::AnswerSeat { identity, accept, watchers, now } => session::answer_seat(doc, &set(identity), accept, &watchers, now),
        Action::Settle { now } => return changed(session::settle(doc, now)),
        Action::AbandonLive {} => return changed(session::abandon_live(doc)),
        Action::View { identity, code, version, now, audience } => {
            let name = |token: &str| audience.names.get(token).unwrap_or_else(|| panic!("the case gives no name for {token}")).clone();
            let person = |token: &str| audience.persons.get(token).cloned().flatten();
            let identity = set(identity);
            let context = ViewContext {
                code: &code,
                version,
                identity: &identity,
                now,
                audience: Audience { presence: audience.presence, watchers: &audience.watchers, name: &name, person: &person },
                players: PerPlayer { x: None, o: None },
            };
            return (json!({ "view": session::view_of(doc, context) }), None);
        }
    };
    let json = doc_json(&result);
    (json, result.ok())
}

fn changed(next: Option<SessionDoc>) -> (Value, Option<SessionDoc>) {
    match next {
        Some(doc) => (json!({ "doc": doc }), Some(doc)),
        None => (json!({ "unchanged": true }), None),
    }
}

/// The first step of a case whose Rust result differs from the stored one, with both results.
fn first_difference(case: &SessionCase) -> Option<String> {
    let started = session::create_doc(&case.create.name, case.create.clock, case.create.seats.clone());
    let start = doc_json(&started);
    if start != case.start {
        return Some(format!("create\n  rust: {start}\n  case: {}", case.start));
    }
    let mut doc = started.ok();
    for (index, step) in case.steps.iter().enumerate() {
        let current = doc.as_ref().unwrap_or_else(|| panic!("case {} has steps after a failed create", case.name));
        let action: Action =
            serde_json::from_value(step.clone()).unwrap_or_else(|error| panic!("case {} step {index}: {error}", case.name));
        let (result, next) = apply(current, action);
        if result != step["result"] {
            return Some(format!("step {index} ({})\n  rust: {result}\n  case: {}", step["op"], step["result"]));
        }
        if next.is_some() {
            doc = next;
        }
    }
    None
}

fn cases() -> Cases {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/session/rule-cases.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).expect("rule-cases.json has the shape of RuleCases in src/session/rule-cases.ts")
}

#[test]
fn every_rule_case_gives_the_same_result() {
    let cases = cases();
    assert!(!cases.sessions.is_empty(), "rule-cases.json has no sessions");
    let failures: Vec<String> = cases
        .sessions
        .iter()
        .filter_map(|case| first_difference(case).map(|difference| format!("case \"{}\": {difference}", case.name)))
        .collect();
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.sessions.len(), failures.join("\n\n"));

    for case in &cases.replays {
        let result = match replay(&case.moves, case.first, None, NO_LIMIT) {
            Ok(game) => json!({ "game": game }),
            Err(message) => json!({ "error": message }),
        };
        assert_eq!(result, case.result, "replay of {:?}", case.moves);
    }

    let lines: Vec<Line> = cases.lines.iter().map(|case| case.line).collect();
    assert_eq!(lines, *LINES, "the winning lines differ in content or order");
    for case in &cases.lines {
        assert_eq!(json!(line_kind(&case.line)), case.kind, "kind of line {:?}", case.line);
    }

    for case in &cases.names {
        assert_eq!(name_of(&case.token), case.name, "name of {}", case.token);
    }
}

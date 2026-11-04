//! Reads a stored session document of any known format, as parseDoc in src/session/format.ts does.
//! Missing optional fields get their defaults. Every write passes the same check as every read, so the table
//! never holds a document that cannot be read back.
use serde_json::{Map, Value, json};
use tick3d_core::game::replay;
use tick3d_core::session::{CHAT_KEEP, CURRENT_FORMAT, SessionDoc};

use crate::protocol::{normalize_name, parse_clock};

/// A stored document and whether it was in an older form, so the store writes it back in the current form.
pub struct ParsedDoc {
    pub doc: SessionDoc,
    pub stale: bool,
}

pub fn parse_doc(stored: Value) -> Result<ParsedDoc, String> {
    let Value::Object(mut doc) = stored else { return Err("a session document must be an object".into()) };
    let format = doc.get("format").cloned().unwrap_or(json!(1));
    let format = format.as_u64().filter(|format| *format >= 1).ok_or_else(|| format!("unknown format {format}"))?;
    if format > u64::from(CURRENT_FORMAT) {
        return Err(format!("format {format} is newer than this server ({CURRENT_FORMAT})"));
    }
    // UPGRADES in src/session/format.ts is empty: format 1 is the only format.
    let stale = doc.get("format") != Some(&json!(CURRENT_FORMAT));
    doc.insert("format".into(), json!(CURRENT_FORMAT));

    let name = normalize_name(doc.get("name").unwrap_or(&Value::Null)).ok_or("the session name is missing or invalid")?;
    doc.insert("name".into(), json!(name));
    match doc.get("mode") {
        None | Some(Value::Null) => doc.insert("mode".into(), json!("online")),
        Some(mode) if mode == "online" => None,
        Some(mode) => return Err(format!("the Rust server reads only online sessions, not {mode}")),
    };
    doc.insert("computer".into(), Value::Null);
    let games =
        doc.get_mut("games").and_then(Value::as_array_mut).filter(|games| !games.is_empty()).ok_or("a session needs at least one game")?;
    for game in games.iter_mut() {
        let game = game.as_object_mut().ok_or("a game is not an object")?;
        default(game, "clock", json!({ "perMove": null, "perGame": null }));
        default(game, "timedOut", json!(false));
        if !game.contains_key("times") {
            let moves = game.get("moves").and_then(Value::as_array).map_or(0, Vec::len);
            game.insert("times".into(), json!(vec![0; moves]));
        }
    }
    let game_count = games.len();
    let seats = doc.entry("seats").or_insert(json!({}));
    let seats = seats.as_object_mut().ok_or("the seats are not an object")?;
    default(seats, "X", Value::Null);
    default(seats, "O", Value::Null);
    let options = doc.get("options").and_then(Value::as_object);
    // A field that an older writer left out reads as false.
    let option = |key: &str| options.and_then(|options| options.get(key)) == Some(&json!(true));
    let options =
        json!({ "hideBoard": option("hideBoard"), "hideHistory": option("hideHistory"), "hideCoordinates": option("hideCoordinates") });
    doc.insert("options".into(), options);
    if !doc.get("lockedGame").is_some_and(|game| game.as_u64().is_some()) {
        doc.insert("lockedGame".into(), Value::Null);
    }
    match doc.get("clock") {
        None => {
            doc.insert("clock".into(), json!({ "perMove": null, "perGame": null }));
        }
        Some(clock) => {
            parse_clock(clock).ok_or("the session clock is invalid")?;
        }
    }
    let chat = doc.entry("chat").or_insert(json!([]));
    let chat = chat.as_array_mut().ok_or("the chat is invalid")?;
    let extra = chat.len().saturating_sub(CHAT_KEEP);
    chat.drain(..extra);
    default(&mut doc, "playoff", Value::Null);
    default(&mut doc, "seatRequest", Value::Null);
    if !doc.contains_key("fixedSeats") {
        // defaultFixedSeats('online') is false.
        doc.insert("fixedSeats".into(), json!(false));
    }
    let fixed = doc.get("fixedSeats") == Some(&json!(true));
    doc.insert("fixedSeats".into(), json!(fixed));
    let watcher_chat = doc.get("watcherChat") != Some(&json!(false));
    doc.insert("watcherChat".into(), json!(watcher_chat));
    default(&mut doc, "flipped", json!(vec![false; game_count]));

    let doc: SessionDoc = serde_json::from_value(Value::Object(doc)).map_err(|error| format!("the session does not parse: {error}"))?;
    if doc.flipped.len() != doc.games.len() {
        return Err("the flipped seats do not match the games".into());
    }
    for (index, game) in doc.games.iter().enumerate() {
        if game.times.len() != game.moves.len() {
            return Err(format!("game {index} has invalid move times"));
        }
        let replayed = replay(&game.moves, tick3d_core::game::Player::X, Some(&game.times), game.clock)
            .map_err(|_| format!("game {index} does not replay"))?;
        // to_game applies the flags and panics on a game that is already over, so such a document must not parse.
        if (game.timed_out || game.abandoned) && (!replayed.is_playing() || (game.timed_out && game.abandoned)) {
            return Err(format!("game {index} has an end flag that its moves do not allow"));
        }
    }
    Ok(ParsedDoc { doc, stale })
}

fn default(object: &mut Map<String, Value>, key: &str, value: Value) {
    object.entry(key).or_insert(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A game with both end flags, or an end flag on a game that its moves already ended, is refused, not a panic later.
    #[test]
    fn refuses_end_flags_that_the_moves_do_not_allow() {
        let cases: Value = serde_json::from_str(include_str!("../../../src/session/rule-cases.json")).expect("rule-cases.json parses");
        let doc = cases["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .flat_map(|session| session["steps"].as_array().expect("steps").iter())
            .filter_map(|step| step["result"].get("doc").cloned())
            .find(|doc| parse_doc(doc.clone()).is_ok())
            .expect("a rule case document that reads");
        let with_flags = |timed_out: bool, abandoned: bool| {
            let mut doc = doc.clone();
            let game = &mut doc["games"][0];
            game["timedOut"] = json!(timed_out);
            game["abandoned"] = json!(abandoned);
            parse_doc(doc)
        };
        assert!(with_flags(true, true).is_err());
    }

    /// Every document of the shared rule cases reads back as itself. The random cases rename sessions without the
    /// name check of the routes (src/session/core.ts does not check it), so a document with such a name does not count.
    #[test]
    fn rule_case_documents_read_back() {
        let cases: Value = serde_json::from_str(include_str!("../../../src/session/rule-cases.json")).expect("rule-cases.json parses");
        let mut count = 0;
        for session in cases["sessions"].as_array().expect("sessions") {
            for step in session["steps"].as_array().expect("steps") {
                let Some(doc) = step["result"].get("doc") else { continue };
                if normalize_name(&doc["name"]).as_deref() != doc["name"].as_str() {
                    continue;
                }
                let parsed = parse_doc(doc.clone()).unwrap_or_else(|error| panic!("{}: {error}", session["name"]));
                assert!(!parsed.stale);
                assert_eq!(serde_json::to_value(&parsed.doc).expect("a document serializes"), *doc);
                count += 1;
            }
        }
        assert!(count > 500, "only {count} documents");
    }

    #[test]
    fn old_documents_get_defaults() {
        let parsed = parse_doc(json!({ "name": "old", "games": [{ "moves": [0], "times": [5] }], "seats": { "X": "a" } }))
            .expect("an old document parses");
        assert!(parsed.stale);
        assert_eq!(parsed.doc.flipped, vec![false]);
        assert!(parsed.doc.watcher_chat);
        assert!(parse_doc(json!({ "format": 2, "name": "new", "games": [] })).is_err());
    }
}

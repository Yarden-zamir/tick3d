//! Finished games as players read them (server/store.ts: game, history, clearHistory, records, myGames).
use std::collections::{BTreeMap, HashMap};

use duckdb::ToSql;
use serde::Serialize;
use serde_json::Value;
use tick3d_core::game::{PerPlayer, Player, Status};
use tick3d_core::names::name_of;
use tick3d_core::session::{COMPUTER_TOKEN, GameRecord, MatchOptions, PlayerInfo};

use super::accounts::{account_of, account_row};
use super::{Db, metric_lists, now_ms};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{Difficulty, GameId, GameMode, has_result, parse_game_record, parse_match_options, parse_result_upload};

/// The largest safe integer of JavaScript: the read of a stored result accepts any finish time.
const MAX_EPOCH_MS: i64 = (1 << 53) - 1;
/// HISTORY_PAGE_SIZE in src/protocol.ts.
const HISTORY_PAGE_SIZE: usize = 50;

/// `column IN ($t0, …)`. A list of bound values, not list_contains: then DuckDB uses the index of the column.
fn in_tokens(column: &str, count: usize) -> String {
    assert!(count > 0, "a player has at least one token");
    format!("{column} IN ({})", (0..count).map(|index| format!("$t{index}")).collect::<Vec<_>>().join(", "))
}

/// The rows of `table` where one of `count` tokens holds a seat, through the indexes of the two seat columns. A row with
/// the player on both seats (a friend game) comes once. Use it as `FROM {seated_rows(..)} <table>`.
fn seated_rows(table: &str, seat_x: &str, seat_o: &str, count: usize) -> String {
    format!(
        "(FROM {table} WHERE {} UNION ALL FROM {table} WHERE {} AND ({seat_x} IS NULL OR NOT {}))",
        in_tokens(seat_x, count),
        in_tokens(seat_o, count),
        in_tokens(seat_x, count)
    )
}

fn seated_results(count: usize) -> String {
    seated_rows("results", "player_x", "player_o", count)
}

/// The names of the bound tokens of in_tokens: t0, t1, …
fn token_names(tokens: &[String]) -> Vec<String> {
    (0..tokens.len()).map(|index| format!("t{index}")).collect()
}

fn token_params<'a>(names: &'a [String], tokens: &'a [String]) -> Vec<(&'a str, &'a dyn ToSql)> {
    names.iter().zip(tokens).map(|(name, token)| (name.as_str(), token as &dyn ToSql)).collect()
}

/// Joins the account of each seat of a result row (SEAT_ACCOUNTS in server/store.ts).
const SEAT_ACCOUNTS: &str = "LEFT JOIN player_tokens tx ON tx.token = results.player_x LEFT JOIN users ux ON ux.github_id = tx.github_id
  LEFT JOIN player_tokens t_o ON t_o.token = results.player_o LEFT JOIN users uo ON uo.github_id = t_o.github_id";
/// Ten columns: the account of X, then of O, each as provider, login, avatar, name, seed. Then the two seat tokens.
const SEAT_COLUMNS: &str = "ux.provider, ux.login, ux.avatar, ux.name, ux.seed, uo.provider, uo.login, uo.avatar, uo.name, uo.seed,
  results.player_x, results.player_o";

/// The seat accounts and seat tokens of a row, from SEAT_COLUMNS at `first`.
struct Seats {
    players: PerPlayer<Option<PlayerInfo>>,
    tokens: PerPlayer<Option<String>>,
}

fn seats_at(
    row: &duckdb::Row,
    first: usize,
) -> duckdb::Result<(super::accounts::AccountRow, super::accounts::AccountRow, Option<String>, Option<String>)> {
    Ok((account_row(row, first)?, account_row(row, first + 5)?, row.get(first + 10)?, row.get(first + 11)?))
}

fn seats_of(found: (super::accounts::AccountRow, super::accounts::AccountRow, Option<String>, Option<String>)) -> ApiResult<Seats> {
    let (x, o, token_x, token_o) = found;
    Ok(Seats { players: PerPlayer { x: account_of(x)?, o: account_of(o)? }, tokens: PerPlayer { x: token_x, o: token_o } })
}

fn winner_of(status: &Status) -> Option<Player> {
    match status {
        Status::Won { winner, .. } | Status::Timeout { winner } => Some(*winner),
        _ => None,
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Won,
    Lost,
    Drawn,
    Played,
}

/// outcomeOf: a friend game has no "you", so it is only played.
fn outcome_of(winner: Option<Player>, you: Option<Player>) -> Outcome {
    match (you, winner) {
        (None, _) => Outcome::Played,
        (Some(_), None) => Outcome::Drawn,
        (Some(you), Some(winner)) if you == winner => Outcome::Won,
        _ => Outcome::Lost,
    }
}

/// The stored document of a result row: an upload from a device, or an online game that the server recorded.
struct StoredGame {
    mode: GameMode,
    game: GameRecord,
    status: Status,
    you: Option<Player>,
    difficulty: Option<Difficulty>,
    options: MatchOptions,
    tuned: bool,
}

/// readStored in server/store.ts. A stored document that does not parse is a fault.
fn read_stored(doc: &Value, now: i64) -> ApiResult<StoredGame> {
    if doc.get("mode").and_then(Value::as_str) == Some("online") {
        let parsed = doc.get("game").and_then(parse_game_record).filter(|(_, status)| has_result(status));
        // A game stored before hideCoordinates reads it as false.
        let options = doc.get("options").and_then(parse_match_options);
        let (Some((game, status)), Some(options)) = (parsed, options) else {
            return Err(ApiError::fault("a stored online game does not parse"));
        };
        return Ok(StoredGame { mode: GameMode::Online, game, status, you: None, difficulty: None, options, tuned: false });
    }
    let upload = parse_result_upload(metric_lists(), doc, now).ok_or_else(|| ApiError::fault("a stored result does not parse"))?;
    let status = upload.game.to_game().status;
    Ok(StoredGame {
        mode: upload.mode,
        game: upload.game,
        status,
        you: upload.you,
        difficulty: upload.difficulty,
        options: upload.options,
        tuned: upload.tuned,
    })
}

/// A finished game as anybody with its link sees it. It has no tokens and no result id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicGame {
    id: String,
    mode: GameMode,
    game: PublicRecord,
    options: MatchOptions,
    difficulty: Option<Difficulty>,
    tuned: bool,
    /// The computer's seat, in a computer game.
    computer: Option<Player>,
    players: PerPlayer<Option<PlayerInfo>>,
    names: PerPlayer<Option<String>>,
    finished_at: i64,
}

/// The fields of a finished game record in a public answer (parsePublicGame keeps these four).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRecord {
    moves: Vec<tick3d_core::game::Cell>,
    times: Vec<i64>,
    clock: tick3d_core::clock::TimeControl,
    timed_out: bool,
}

impl From<GameRecord> for PublicRecord {
    fn from(record: GameRecord) -> PublicRecord {
        PublicRecord { moves: record.moves, times: record.times, clock: record.clock, timed_out: record.timed_out }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    id: Option<String>,
    mode: GameMode,
    difficulty: Option<Difficulty>,
    result: Outcome,
    moves: i64,
    opponent: Option<PlayerInfo>,
    opponent_name: Option<String>,
    finished_at: i64,
}

#[derive(Serialize)]
pub struct HistoryPage {
    games: Vec<HistoryEntry>,
    more: bool,
}

#[derive(Default, Serialize)]
pub struct Tally {
    played: u32,
    won: u32,
    lost: u32,
    drawn: u32,
}

impl Tally {
    fn count(&mut self, outcome: Outcome) {
        self.played += 1;
        match outcome {
            Outcome::Won => self.won += 1,
            Outcome::Lost => self.lost += 1,
            Outcome::Drawn => self.drawn += 1,
            Outcome::Played => {}
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    code: String,
    name: String,
    games: usize,
    you: Player,
    opponent: Option<PlayerInfo>,
    /// The generated name of the other player. None while their seat is empty.
    opponent_name: Option<String>,
    your_turn: bool,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyGames {
    user: Option<PlayerInfo>,
    total: Tally,
    by_mode: BTreeMap<&'static str, Tally>,
    by_difficulty: BTreeMap<&'static str, Tally>,
    sessions: Vec<SessionSummary>,
}

/// recordKey in src/records.ts. Hidden coordinates and a tuned computer add a part only when they are on.
fn record_key(stored: &StoredGame, difficulty: Difficulty) -> String {
    let limit = |limit: Option<u32>| limit.map_or("none".to_owned(), |limit| limit.to_string());
    let clock = stored.game.clock;
    let mut parts = vec![
        difficulty.as_str().to_owned(),
        format!("game:{}", limit(clock.per_game)),
        format!("move:{}", limit(clock.per_move)),
        format!("board:{}", stored.options.hide_board),
        format!("history:{}", stored.options.hide_history),
    ];
    if stored.options.hide_coordinates {
        parts.push("coordinates".into());
    }
    if stored.tuned {
        parts.push("tuned".into());
    }
    parts.join("|")
}

impl Db {
    /// seatNames: the shown name of each seat holder. An empty seat and the computer have none.
    fn seat_names(&mut self, tokens: &PerPlayer<Option<String>>) -> ApiResult<PerPlayer<Option<String>>> {
        let asked: Vec<&str> = [&tokens.x, &tokens.o].into_iter().flatten().map(String::as_str).collect();
        let names = self.names_of(&asked)?;
        let name = |token: &Option<String>| {
            token
                .as_deref()
                .filter(|token| *token != COMPUTER_TOKEN)
                .map(|token| names.get(token).cloned().unwrap_or_else(|| name_of(token)))
        };
        Ok(PerPlayer { x: name(&tokens.x), o: name(&tokens.o) })
    }

    /// One finished game for its read-only link. 404 for an unknown id.
    pub fn game(&mut self, id: &GameId) -> ApiResult<PublicGame> {
        let text = id.text();
        let found = self.query(
            &format!("FROM results {SEAT_ACCOUNTS} SELECT results.doc::JSON::VARCHAR, epoch_ms(results.finished_at), {SEAT_COLUMNS} WHERE public_id = $id"),
            &[("id", &text)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, seats_at(row, 2)?)),
        )?;
        let Some((doc, finished_at, seats)) = found.into_iter().next() else { return self.online_game_from_session(id) };
        let stored = read_stored(&serde_json::from_str(&doc).map_err(ApiError::fault)?, MAX_EPOCH_MS)?;
        let seats = seats_of(seats)?;
        Ok(PublicGame {
            id: text,
            mode: stored.mode,
            computer: if stored.mode == GameMode::Computer { stored.you.map(Player::other) } else { None },
            game: stored.game.into(),
            options: stored.options,
            difficulty: stored.difficulty,
            tuned: stored.tuned,
            names: self.seat_names(&seats.tokens)?,
            players: seats.players,
            finished_at,
        })
    }

    /// An online game that ended before the server recorded games in `results` reads from its session.
    /// The hide options are those of the session now: the session does not keep them per game.
    fn online_game_from_session(&mut self, id: &GameId) -> ApiResult<PublicGame> {
        let (row, index) = self.finished_online_game(id)?;
        // The players of that game, by the seat that each one held in it.
        let holder = |seat: Player| if row.doc.flipped.get(index) == Some(&true) { seat.other() } else { seat };
        let players = self.players_of(&row.doc)?;
        let tokens = PerPlayer { x: row.doc.seats.get(holder(Player::X)).clone(), o: row.doc.seats.get(holder(Player::O)).clone() };
        let game = row.doc.games[index].clone();
        Ok(PublicGame {
            id: id.text(),
            mode: GameMode::Online,
            finished_at: game.times.last().copied().unwrap_or_else(now_ms),
            game: game.into(),
            options: row.doc.options,
            difficulty: None,
            tuned: false,
            computer: None,
            players: PerPlayer { x: players.get(holder(Player::X)).clone(), o: players.get(holder(Player::O)).clone() },
            names: self.seat_names(&tokens)?,
        })
    }

    /// The finished games of this player in every mode, on all their linked devices, newest first.
    /// A seat that its player cleared is not in the history. A Nearby guest row with a host row is left out.
    pub fn history(&mut self, token: &str, offset: i64) -> ApiResult<HistoryPage> {
        let tokens: Vec<String> = self.identity_of(Some(token))?.into_iter().collect();
        let count = tokens.len();
        let sql = format!(
            "FROM {seated} results {SEAT_ACCOUNTS}
             SELECT results.public_id, results.mode, results.level, results.winner, results.ending,
               CASE WHEN results.ending IS NULL THEN results.doc::JSON::VARCHAR END, len(results.moves)::BIGINT, epoch_ms(results.finished_at),
               coalesce({mine_x}, false), coalesce({mine_o}, false), {SEAT_COLUMNS}
             WHERE ((coalesce({mine_x}, false) AND results.hidden_x IS NOT TRUE) OR (coalesce({mine_o}, false) AND results.hidden_o IS NOT TRUE))
               AND NOT {host_has_game}
             ORDER BY results.finished_at DESC, results.id
             LIMIT $limit OFFSET $offset",
            seated = seated_results(count),
            mine_x = in_tokens("results.player_x", count),
            mine_o = in_tokens("results.player_o", count),
            host_has_game = *HOST_HAS_GAME,
        );
        let names = token_names(&tokens);
        let limit = (HISTORY_PAGE_SIZE + 1) as i64;
        let mut params = token_params(&names, &tokens);
        params.push(("limit", &limit));
        params.push(("offset", &offset));
        type HistoryRow = (Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, bool, bool);
        let found = self.query(&sql, &params, |row| {
            let fields: HistoryRow = (
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            );
            Ok((fields, seats_at(row, 10)?))
        })?;
        let more = found.len() > HISTORY_PAGE_SIZE;
        let all_tokens: Vec<String> = found.iter().flat_map(|(_, (.., x, o))| [x.clone(), o.clone()]).flatten().collect();
        let refs: Vec<&str> = all_tokens.iter().map(String::as_str).collect();
        let name_map = self.names_of(&refs)?;
        let name = |token: &Option<String>| {
            token
                .as_deref()
                .filter(|token| *token != COMPUTER_TOKEN)
                .map(|token| name_map.get(token).cloned().unwrap_or_else(|| name_of(token)))
        };
        let text_value = |text: Option<String>| text.map_or(Value::Null, Value::from);
        let mut games = Vec::new();
        for ((public_id, mode, level, winner, ending, old_doc, moves, finished_at, mine_x, mine_o), seats) in
            found.into_iter().take(HISTORY_PAGE_SIZE)
        {
            let seats = seats_of(seats)?;
            // A friend game holds this player on both seats.
            let you = match (mine_x, mine_o) {
                (true, true) => None,
                (true, false) => Some(Player::X),
                _ => Some(Player::O),
            };
            // A row from before game links has no ending columns: replay its game.
            let winner = match (ending, old_doc) {
                (None, Some(doc)) => winner_of(&read_stored(&serde_json::from_str(&doc).map_err(ApiError::fault)?, MAX_EPOCH_MS)?.status),
                (None, None) => return Err(ApiError::fault("a result without an ending has no document")),
                (Some(_), _) => serde_json::from_value::<Option<Player>>(text_value(winner)).map_err(ApiError::fault)?,
            };
            let opponent = you.map(Player::other);
            games.push(HistoryEntry {
                // A row from before game links has no public id, so it has no link.
                id: public_id,
                mode: serde_json::from_value(Value::from(mode)).map_err(ApiError::fault)?,
                difficulty: serde_json::from_value(text_value(level)).map_err(ApiError::fault)?,
                result: outcome_of(winner, you),
                moves,
                opponent: opponent.and_then(|seat| seats.players.get(seat).clone()),
                opponent_name: opponent.and_then(|seat| name(seats.tokens.get(seat))),
                finished_at,
            });
        }
        Ok(HistoryPage { games, more })
    }

    /// Hides every finished game of this player from their history, on all linked devices. The other seat of a shared
    /// game keeps it, and the stats and survival records still count it. Returns how many seats it hid.
    pub fn clear_history(&mut self, token: &str) -> ApiResult<usize> {
        let tokens: Vec<String> = self.identity_of(Some(token))?.into_iter().collect();
        let names = token_names(&tokens);
        let mut hidden = 0;
        for (column, seat) in [("hidden_x", "player_x"), ("hidden_o", "player_o")] {
            let sql =
                format!("UPDATE results SET {column} = true WHERE {} AND {column} IS NOT TRUE RETURNING id", in_tokens(seat, tokens.len()));
            hidden += self.query(&sql, &token_params(&names, &tokens), |row| row.get::<_, String>(0))?.len();
        }
        Ok(hidden)
    }

    /// The survival records of this player on all their linked devices: per setup, the most moves of a game that the
    /// computer won. Same keys as the records on the device (src/records.ts). A cleared game still counts.
    pub fn records(&mut self, token: &str) -> ApiResult<BTreeMap<String, usize>> {
        let tokens: Vec<String> = self.identity_of(Some(token))?.into_iter().collect();
        let names = token_names(&tokens);
        let docs = self.query(
            &format!("FROM {} results SELECT doc::JSON::VARCHAR WHERE mode = 'computer'", seated_results(tokens.len())),
            &token_params(&names, &tokens),
            |row| row.get::<_, String>(0),
        )?;
        let mut records = BTreeMap::new();
        for doc in docs {
            let stored = read_stored(&serde_json::from_str(&doc).map_err(ApiError::fault)?, MAX_EPOCH_MS)?;
            let (Some(difficulty), Some(you)) = (stored.difficulty, stored.you) else {
                return Err(ApiError::fault("a stored computer game has no level or no seat"));
            };
            match winner_of(&stored.status) {
                Some(winner) if winner != you => {
                    let moves = stored.game.moves.len();
                    let best = records.entry(record_key(&stored, difficulty)).or_insert(moves);
                    *best = (*best).max(moves);
                }
                _ => {}
            }
        }
        Ok(records)
    }

    /// The games of this player: tallies by mode and level, and the online sessions with a seat now.
    pub fn my_games(&mut self, token: &str) -> ApiResult<MyGames> {
        let identity = self.identity_of(Some(token))?;
        let tokens: Vec<String> = identity.iter().cloned().collect();
        let names = token_names(&tokens);
        let mut total = Tally::default();
        let mut by_mode: BTreeMap<&'static str, Tally> =
            ["computer", "friend", "online", "nearby"].into_iter().map(|mode| (mode, Tally::default())).collect();
        let mut by_difficulty: BTreeMap<&'static str, Tally> =
            ["easy", "medium", "hard"].into_iter().map(|level| (level, Tally::default())).collect();

        let saved = self.query(
            &format!("FROM {} sessions SELECT code", seated_rows("sessions", "seat_x", "seat_o", tokens.len())),
            &token_params(&names, &tokens),
            |row| row.get::<_, String>(0),
        )?;
        let mut held = self.sessions_where(saved, |doc| !doc.seats_of(&identity).is_empty())?;
        held.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
        let mut seated = Vec::new();
        for row in held {
            let Some(&you) = row.doc.seats_of(&identity).first() else { continue };
            for (index, record) in row.doc.games.iter().enumerate() {
                let status = record.to_game().status;
                if !has_result(&status) {
                    continue;
                }
                // The seats rotate between games, so the seat of this player in that game can differ from now.
                let seat = if row.doc.flipped.get(index) == Some(&true) { you.other() } else { you };
                let outcome = outcome_of(winner_of(&status), Some(seat));
                total.count(outcome);
                by_mode.get_mut("online").expect("online is a mode").count(outcome);
            }
            seated.push((row, you));
        }
        // One query for the accounts and one for the names of every opponent, not two per session.
        let opponents: Vec<String> = seated.iter().filter_map(|(row, you)| row.doc.seats.get(you.other()).clone()).collect();
        let refs: Vec<&str> = opponents.iter().map(String::as_str).collect();
        let accounts = self.accounts_of(&refs)?;
        let name_map: HashMap<String, String> = self.names_of(&refs)?;
        let sessions = seated
            .into_iter()
            .map(|(row, you)| {
                let live = row.doc.current_game();
                let opponent = row.doc.seats.get(you.other()).clone();
                SessionSummary {
                    games: row.doc.games.iter().filter(|record| !record.moves.is_empty()).count(),
                    you,
                    opponent: opponent.as_ref().and_then(|token| accounts.get(token).cloned()),
                    opponent_name: opponent
                        .as_deref()
                        .filter(|token| *token != COMPUTER_TOKEN)
                        .map(|token| name_map.get(token).cloned().unwrap_or_else(|| name_of(token))),
                    your_turn: live.is_playing() && live.turn == you && opponent.is_some(),
                    updated_at: row.updated_at,
                    name: row.doc.name,
                    code: row.code,
                }
            })
            .collect();

        // The online rows of results repeat the session games counted above, so they stay out.
        let docs = self.query(
            &format!(
                "FROM {} results SELECT doc::JSON::VARCHAR WHERE {} AND mode <> 'online'",
                seated_results(tokens.len()),
                in_tokens("results.token", tokens.len())
            ),
            &token_params(&names, &tokens),
            |row| row.get::<_, String>(0),
        )?;
        let now = now_ms();
        for doc in docs {
            let stored = read_stored(&serde_json::from_str(&doc).map_err(ApiError::fault)?, now)?;
            let outcome = outcome_of(winner_of(&stored.status), stored.you);
            total.count(outcome);
            let mode = serde_json::to_value(stored.mode).map_err(ApiError::fault)?;
            by_mode.get_mut(mode.as_str().expect("a mode is a text")).expect("every mode has a tally").count(outcome);
            if let Some(level) = stored.difficulty {
                by_difficulty.get_mut(level.as_str()).expect("every level has a tally").count(outcome);
            }
        }
        let user = self
            .query(
                "FROM player_tokens JOIN users USING (github_id) SELECT provider, login, avatar, name, seed WHERE token = $token",
                &[("token", &token)],
                |row| account_row(row, 0),
            )?
            .into_iter()
            .next()
            .map(account_of)
            .transpose()?
            .flatten();
        Ok(MyGames { user, total, by_mode, by_difficulty, sessions })
    }
}

/// The guest rows that have a host row on `seat`, as one join of the few Nearby rows (guestCopies in server/store.ts).
fn guest_copies(seat: &str) -> String {
    format!(
        "SELECT guest.id FROM results guest JOIN results host ON host.{seat} = guest.token
           WHERE guest.nearby_role = 'guest' AND host.mode = 'nearby' AND host.nearby_role = 'host' AND host.token <> guest.token
             AND host.moves = guest.moves AND abs(epoch_ms(host.finished_at) - epoch_ms(guest.finished_at)) < 600000"
    )
}

/// True for the result of a Nearby guest when the host's result of the same game names the guest (HOST_HAS_GAME in
/// server/store.ts). Both devices send a result, so the guest's history then lists the host's row only. Two games of the
/// same two players with the same moves inside 10 minutes count as one.
/// One equality join per host seat, so DuckDB can hash them: a correlated EXISTS joined every result.
static HOST_HAS_GAME: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "(results.nearby_role IS NOT DISTINCT FROM 'guest' AND results.id IN ({} UNION {}))",
        guest_copies("player_x"),
        guest_copies("player_o")
    )
});

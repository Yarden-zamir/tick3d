// The rules of an online session, as pure functions over its document. A copy of src/session/core.ts
// for the online mode only: the server holds only online sessions. The other modes run on one device.
// No function here does I/O: each takes a document and returns a new one, or a SessionError.
// Limit: each change clones the document, as the TypeScript rules copy it. Revisit if a profile of the
// server shows the clone of long sessions (many games or chat entries) as a cost.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::clock::{NO_LIMIT, TimeControl, is_flagged};
use crate::game::{Cell, EpochMs, Game, PerPlayer, Player, Status, replay};
use crate::playoff::{Playoff, PlayoffRequest, apply_playoff};

pub const CURRENT_FORMAT: u32 = 1;
pub const NAME_MAX_LENGTH: usize = 40;
pub const CHAT_MAX_LENGTH: usize = 200;
/// A session keeps its newest chat entries only.
pub const CHAT_KEEP: usize = 50;
/// A request that nobody answers ends after this time.
pub const SEAT_REQUEST_MS: i64 = 60_000;
pub const COMPUTER_TOKEN: &str = "computer";

/// The HTTP status of a refusal: `ErrorStatus::Conflict as u16` is 409.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorStatus {
    BadRequest = 400,
    Forbidden = 403,
    NotFound = 404,
    Conflict = 409,
}

/// A code that a client can test, for a refusal that needs a specific reaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// The move is in the game already, so an earlier copy of the request counted.
    AlreadyPlayed,
}

/// A refusal of a rule. The message text matches src/session/core.ts, because the pages show it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionError {
    pub status: ErrorStatus,
    pub message: String,
    pub code: Option<ErrorCode>,
}

impl SessionError {
    fn new(status: ErrorStatus, message: impl Into<String>) -> SessionError {
        SessionError { status, message: message.into(), code: None }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> SessionError {
        SessionError::new(ErrorStatus::Conflict, message)
    }
}

type Rule<T = SessionDoc> = Result<T, SessionError>;

/// The tokens a caller holds: the own device, the other devices of a logged-in player.
pub type Identity = HashSet<String>;

/// One game as stored. `abandoned` is in the JSON only when it is true.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRecord {
    pub moves: Vec<Cell>,
    pub times: Vec<EpochMs>,
    pub clock: TimeControl,
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub abandoned: bool,
}

impl GameRecord {
    fn empty(clock: TimeControl) -> GameRecord {
        GameRecord { moves: vec![], times: vec![], clock, timed_out: false, abandoned: false }
    }

    /// Panics on a record that does not replay: parsing a stored document checks that first.
    pub fn to_game(&self) -> Game {
        let game = replay(&self.moves, Player::X, Some(&self.times), self.clock).expect("a stored game replays");
        let ended = if self.timed_out { game.time_out() } else { game };
        if self.abandoned { ended.abandon() } else { ended }
    }

    fn of(game: &Game) -> GameRecord {
        GameRecord {
            moves: game.moves.clone(),
            times: game.times.clone(),
            clock: game.clock,
            timed_out: matches!(game.status, Status::Timeout { .. }),
            abandoned: game.status == Status::Abandoned,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Online,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchOptions {
    pub hide_board: bool,
    pub hide_history: bool,
    pub hide_coordinates: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchOption {
    HideBoard,
    HideHistory,
    HideCoordinates,
}

impl MatchOptions {
    pub const ALL: [MatchOption; 3] = [MatchOption::HideBoard, MatchOption::HideHistory, MatchOption::HideCoordinates];

    pub fn get(&self, option: MatchOption) -> bool {
        match option {
            MatchOption::HideBoard => self.hide_board,
            MatchOption::HideHistory => self.hide_history,
            MatchOption::HideCoordinates => self.hide_coordinates,
        }
    }
}

/// `from` is the seat of the sender, or the watcher. `by` is the person id of the sender, when the holder has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatFrom {
    X,
    O,
    #[serde(rename = "watcher")]
    Watcher,
}

impl From<Player> for ChatFrom {
    fn from(player: Player) -> ChatFrom {
        match player {
            Player::X => ChatFrom::X,
            Player::O => ChatFrom::O,
        }
    }
}

/// A change to the session that the chat log shows between the messages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEvent {
    NewGame { game: usize, swapped: bool },
    Option { option: MatchOption, on: bool },
    FixedSeats { on: bool },
    WatcherChat { on: bool },
    Clock { clock: TimeControl },
    Name { name: String },
    Lock,
    Seat { action: SeatKind },
}

/// Messages and events share one id sequence, so the log keeps one order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatEntry {
    Message {
        id: u64,
        from: ChatFrom,
        text: String,
        at: EpochMs,
        #[serde(skip_serializing_if = "Option::is_none")]
        by: Option<String>,
    },
    Event {
        id: u64,
        event: SessionEvent,
    },
}

impl ChatEntry {
    fn id(&self) -> u64 {
        match self {
            ChatEntry::Message { id, .. } | ChatEntry::Event { id, .. } => *id,
        }
    }
}

/// Every seat action, as the chat log names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeatKind {
    Swap,
    Leave,
    Give,
    Seat,
    Unseat,
    Replace,
    Undo,
}

/// The seat actions that change the seat or the game of the other player. They wait until the other player accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentAction {
    Swap,
    Unseat,
    Replace,
    Undo,
}

impl From<ConsentAction> for SeatKind {
    fn from(action: ConsentAction) -> SeatKind {
        match action {
            ConsentAction::Swap => SeatKind::Swap,
            ConsentAction::Unseat => SeatKind::Unseat,
            ConsentAction::Replace => SeatKind::Replace,
            ConsentAction::Undo => SeatKind::Undo,
        }
    }
}

/// What a seated player can do with the seats. `watcher` is the id of a watcher (OpenWatcher::id).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum SeatAction {
    Swap,
    Leave,
    Unseat,
    Undo,
    Give { watcher: String },
    Seat { watcher: String },
    Replace { watcher: String },
}

impl SeatAction {
    fn kind(&self) -> SeatKind {
        match self {
            SeatAction::Swap => SeatKind::Swap,
            SeatAction::Leave => SeatKind::Leave,
            SeatAction::Unseat => SeatKind::Unseat,
            SeatAction::Undo => SeatKind::Undo,
            SeatAction::Give { .. } => SeatKind::Give,
            SeatAction::Seat { .. } => SeatKind::Seat,
            SeatAction::Replace { .. } => SeatKind::Replace,
        }
    }

    fn consent(&self) -> Option<ConsentAction> {
        match self {
            SeatAction::Swap => Some(ConsentAction::Swap),
            SeatAction::Unseat => Some(ConsentAction::Unseat),
            SeatAction::Replace { .. } => Some(ConsentAction::Replace),
            SeatAction::Undo => Some(ConsentAction::Undo),
            SeatAction::Leave | SeatAction::Give { .. } | SeatAction::Seat { .. } => None,
        }
    }

    fn watcher(&self) -> Option<&str> {
        match self {
            SeatAction::Give { watcher } | SeatAction::Seat { watcher } | SeatAction::Replace { watcher } => Some(watcher),
            SeatAction::Swap | SeatAction::Leave | SeatAction::Unseat | SeatAction::Undo => None,
        }
    }
}

/// A seat change that waits for the other player. `watcher` is the token of the watcher that takes
/// the other seat (replace), else None. The request ends SEAT_REQUEST_MS after `at`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatRequest {
    pub kind: ConsentAction,
    pub from: Player,
    pub watcher: Option<String>,
    pub at: EpochMs,
}

/// The stored document of one online session, in format CURRENT_FORMAT (src/session/format.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDoc {
    pub format: u32,
    pub mode: SessionMode,
    /// An online session has no computer. The stored format keeps the field as null.
    pub computer: (),
    pub name: String,
    pub games: Vec<GameRecord>,
    /// Player tokens. Never sent to a page.
    pub seats: PerPlayer<Option<String>>,
    pub options: MatchOptions,
    /// Index of the game that the lock holds. The lock ends when that game ends.
    pub locked_game: Option<usize>,
    /// The time limit for the next game.
    pub clock: TimeControl,
    /// Oldest first, the newest CHAT_KEEP entries only.
    pub chat: Vec<ChatEntry>,
    pub playoff: Option<Playoff>,
    pub seat_request: Option<SeatRequest>,
    /// False: the players swap X and O for each new game. True: the seats stay.
    pub fixed_seats: bool,
    /// True: watchers can write in the chat too.
    pub watcher_chat: bool,
    /// One entry per game: true when the two players sat the other way round in that game.
    pub flipped: Vec<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub game: usize,
    pub move_count: usize,
    pub cell: Cell,
}

/// The fields to change. Limit: the name is not checked here, as in src/session/core.ts: the server
/// checks it when it reads the request (parseSessionUpdate in src/protocol.ts).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUpdate {
    pub name: Option<String>,
    pub clock: Option<TimeControl>,
    pub fixed_seats: Option<bool>,
    pub watcher_chat: Option<bool>,
    pub hide_board: Option<bool>,
    pub hide_history: Option<bool>,
    pub hide_coordinates: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginProvider {
    Github,
    Google,
}

/// An account linked to a seat (PlayerInfo in src/protocol.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerInfo {
    pub provider: LoginProvider,
    pub login: String,
    pub avatar: Option<String>,
    pub name: Option<String>,
    pub seed: Option<String>,
}

/// A device that has the session open. `id` is an opaque handle that the holder makes; the token never leaves the holder.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct OpenWatcher {
    pub id: String,
    pub token: String,
    pub player: Option<PlayerInfo>,
}

// ---- Helpers ----

/// JavaScript `trim()`: the JavaScript white space differs from Rust in U+0085 and U+FEFF.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// The text trimmed, when its length in UTF-16 code units (JavaScript `length`) is 1 to `max`.
fn normalize(text: &str, max: usize) -> Option<&str> {
    let trimmed = js_trim(text);
    (1..=max).contains(&trimmed.encode_utf16().count()).then_some(trimmed)
}

impl SessionDoc {
    pub fn current_game(&self) -> Game {
        self.games.last().expect("a session has games").to_game()
    }

    fn live_index(&self) -> usize {
        self.games.len() - 1
    }

    /// The seats this identity may play, X first.
    pub fn seats_of(&self, identity: &Identity) -> Vec<Player> {
        [Player::X, Player::O]
            .into_iter()
            .filter(|&seat| self.seats.get(seat).as_ref().is_some_and(|token| identity.contains(token)))
            .collect()
    }

    fn require_seat(&self, identity: &Identity) -> Rule<Vec<Player>> {
        let seats = self.seats_of(identity);
        if seats.is_empty() {
            return Err(SessionError::new(ErrorStatus::Forbidden, "Only the two players can change this game."));
        }
        Ok(seats)
    }

    fn first_seat(&self, identity: &Identity) -> Rule<Player> {
        Ok(self.require_seat(identity)?[0])
    }

    fn is_locked(&self) -> bool {
        self.locked_game == Some(self.live_index()) && self.current_game().is_playing()
    }

    fn require_unlocked(&self) -> Rule<()> {
        if self.is_locked() {
            return Err(SessionError::conflict("Settings are locked until this game ends."));
        }
        Ok(())
    }

    fn next_chat_id(&self) -> u64 {
        self.chat.last().map_or(0, ChatEntry::id) + 1
    }

    fn push_chat(&mut self, entry: ChatEntry) {
        self.chat.push(entry);
        let extra = self.chat.len().saturating_sub(CHAT_KEEP);
        self.chat.drain(..extra);
    }

    /// Adds events to the chat log.
    /// Limit: events count toward CHAT_KEEP, so many changes push old messages out sooner. Revisit this
    /// if players lose messages that they still want: then keep events in their own short list.
    fn log_events(mut self, events: Vec<SessionEvent>) -> SessionDoc {
        for event in events {
            let id = self.next_chat_id();
            self.push_chat(ChatEntry::Event { id, event });
        }
        self
    }

    fn replace_current(&self, game: &Game) -> SessionDoc {
        let mut next = self.clone();
        *next.games.last_mut().expect("a session has games") = GameRecord::of(game);
        next
    }

    fn open_request(&self, now: EpochMs) -> Option<&SeatRequest> {
        self.seat_request.as_ref().filter(|request| now < request.at + SEAT_REQUEST_MS)
    }

    /// X and O trade players. An open request and a playoff stay with their players, and each game
    /// that is over keeps who played it (flipped). A live game goes on with the new seats.
    fn swap_seats(&self) -> SessionDoc {
        let last = self.live_index();
        let live = self.current_game().is_playing();
        let mut next = self.clone();
        next.seats = self.seats.clone().swapped();
        if let Some(request) = &mut next.seat_request {
            request.from = request.from.other();
        }
        next.playoff = self.playoff.as_ref().map(Playoff::swapped);
        for (index, entry) in next.flipped.iter_mut().enumerate() {
            if !(index == last && live) {
                *entry = !*entry;
            }
        }
        next
    }
}

// ---- Rules ----

pub fn create_doc(name: &str, clock: TimeControl, seats: PerPlayer<Option<String>>) -> Rule {
    let name = normalize(name, NAME_MAX_LENGTH)
        .ok_or_else(|| SessionError::new(ErrorStatus::BadRequest, format!("A name needs 1 to {NAME_MAX_LENGTH} characters.")))?;
    Ok(SessionDoc {
        format: CURRENT_FORMAT,
        mode: SessionMode::Online,
        computer: (),
        name: name.to_owned(),
        games: vec![GameRecord::empty(clock)],
        seats,
        options: MatchOptions::default(),
        locked_game: None,
        clock,
        chat: vec![],
        playoff: None,
        seat_request: None,
        fixed_seats: false,
        watcher_chat: true,
        flipped: vec![false],
    })
}

/// Takes a free seat for `token`. A caller who already holds a seat keeps it.
pub fn join(doc: &SessionDoc, identity: &Identity, token: &str) -> Rule {
    if !doc.seats_of(identity).is_empty() {
        return Ok(doc.clone());
    }
    let free = [Player::X, Player::O].into_iter().find(|&seat| doc.seats.get(seat).is_none());
    let Some(seat) = free else {
        return Err(SessionError::conflict("Both seats are taken. You can watch this game."));
    };
    let mut next = doc.clone();
    next.seats.set(seat, Some(token.to_owned()));
    Ok(next)
}

/// True when the game and the move index of the request hold its cell, played by a seat of the caller.
/// Then an earlier copy of the request counted, for example one whose answer got lost.
fn is_played(doc: &SessionDoc, seats: &[Player], request: &MoveRequest) -> bool {
    let played = doc.games.get(request.game).and_then(|game| game.moves.get(request.move_count));
    let mover = if request.move_count.is_multiple_of(2) { Player::X } else { Player::O };
    played == Some(&request.cell) && seats.contains(&mover)
}

pub fn play_move(doc: &SessionDoc, identity: &Identity, request: &MoveRequest, now: EpochMs) -> Rule {
    let seats = doc.require_seat(identity)?;
    let game = doc.current_game();
    // The caller sends what it saw. A mismatch means another move landed first, or this move did.
    if request.game != doc.live_index() || request.move_count != game.moves.len() {
        if is_played(doc, &seats, request) {
            return Err(SessionError { code: Some(ErrorCode::AlreadyPlayed), ..SessionError::conflict("This move is played already.") });
        }
        return Err(SessionError::conflict("The board changed. It now shows the latest moves."));
    }
    if let Status::Timeout { winner } = game.status {
        return Err(SessionError::conflict(format!("Time is up. {} ran out of time.", winner.other())));
    }
    if game.is_playing() && !seats.contains(&game.turn) {
        return Err(SessionError::conflict("It is not your turn."));
    }
    let played = game.play(request.cell, now).map_err(|error| {
        SessionError::conflict(match error {
            crate::game::MoveError::Occupied => "That cell is taken.",
            crate::game::MoveError::GameOver => "This game is over.",
        })
    })?;
    // A move ends an undo request: the move to take back is not the last one any more.
    let mut next = doc.replace_current(&played);
    if next.seat_request.as_ref().is_some_and(|request| request.kind == ConsentAction::Undo) {
        next.seat_request = None;
    }
    Ok(next)
}

/// Ends the live game with no winner. None when the live game has no move or is over: then nothing waits.
pub fn abandon_live(doc: &SessionDoc) -> Option<SessionDoc> {
    let game = doc.current_game();
    (game.is_playing() && !game.moves.is_empty()).then(|| doc.replace_current(&game.abandon()))
}

/// Starts the next game. A live game with moves must end first, so nobody can wipe a game they are losing.
pub fn new_game(doc: &SessionDoc, identity: &Identity) -> Rule {
    doc.require_seat(identity)?;
    doc.require_unlocked()?;
    let game = doc.current_game();
    if game.is_playing() && !game.moves.is_empty() {
        return Err(SessionError::conflict("Finish this game first."));
    }
    // An empty live game is replaced, so a new game never leaves an empty one in the history.
    let played = !game.moves.is_empty();
    let mut next = doc.clone();
    if !played {
        next.games.pop();
        next.flipped.pop();
    }
    next.games.push(GameRecord::empty(doc.clock));
    next.flipped.push(false);
    if !played {
        return Ok(next);
    }
    // After a played game the players swap X and O, so the first move alternates.
    let swapped = !doc.fixed_seats;
    let game_number = next.games.len();
    let next = if swapped { next.swap_seats() } else { next };
    Ok(next.log_events(vec![SessionEvent::NewGame { game: game_number, swapped }]))
}

/// The name and the watcher chat stay open during a lock. The match options, the clock and the seat rotation do not.
pub fn update(doc: &SessionDoc, identity: &Identity, changes: &SessionUpdate) -> Rule {
    doc.require_seat(identity)?;
    let changes_match = changes.hide_board.is_some()
        || changes.hide_history.is_some()
        || changes.hide_coordinates.is_some()
        || changes.clock.is_some()
        || changes.fixed_seats.is_some();
    if changes_match {
        doc.require_unlocked()?;
    }
    let mut next = doc.clone();
    if let Some(name) = &changes.name {
        next.name.clone_from(name);
    }
    next.options = MatchOptions {
        hide_board: changes.hide_board.unwrap_or(doc.options.hide_board),
        hide_history: changes.hide_history.unwrap_or(doc.options.hide_history),
        hide_coordinates: changes.hide_coordinates.unwrap_or(doc.options.hide_coordinates),
    };
    next.clock = changes.clock.unwrap_or(doc.clock);
    next.fixed_seats = changes.fixed_seats.unwrap_or(doc.fixed_seats);
    next.watcher_chat = changes.watcher_chat.unwrap_or(doc.watcher_chat);
    // A game keeps the limit it started with. A game without moves has not started yet.
    if let (Some(clock), Some(live)) = (changes.clock, next.games.last_mut())
        && live.moves.is_empty()
        && !live.timed_out
    {
        *live = GameRecord::empty(clock);
    }
    let mut events = vec![];
    if next.name != doc.name {
        events.push(SessionEvent::Name { name: next.name.clone() });
    }
    for option in MatchOptions::ALL {
        if next.options.get(option) != doc.options.get(option) {
            events.push(SessionEvent::Option { option, on: next.options.get(option) });
        }
    }
    if next.clock != doc.clock {
        events.push(SessionEvent::Clock { clock: next.clock });
    }
    if next.fixed_seats != doc.fixed_seats {
        events.push(SessionEvent::FixedSeats { on: next.fixed_seats });
    }
    if next.watcher_chat != doc.watcher_chat {
        events.push(SessionEvent::WatcherChat { on: next.watcher_chat });
    }
    Ok(next.log_events(events))
}

/// Locks the rules of the live game for both players until it ends: the match options, the clock,
/// the seat rotation and undo.
pub fn lock(doc: &SessionDoc, identity: &Identity) -> Rule {
    doc.require_seat(identity)?;
    if doc.is_locked() {
        return Ok(doc.clone());
    }
    if !doc.current_game().is_playing() {
        return Err(SessionError::conflict("This game is over. Start a new game first."));
    }
    // Without a second player the game cannot end, so the lock would hold for good.
    if doc.seats.x.is_none() || doc.seats.o.is_none() {
        return Err(SessionError::conflict("Wait for the second player before a lock."));
    }
    let mut next = doc.clone();
    next.locked_game = Some(doc.live_index());
    Ok(next.log_events(vec![SessionEvent::Lock]))
}

/// The two players write, and the watchers too while watcher_chat is on. `author` is the person id
/// of the caller, from the holder of the session.
pub fn chat(doc: &SessionDoc, identity: &Identity, text: &str, now: EpochMs, author: Option<&str>, watchers: &[OpenWatcher]) -> Rule {
    let from = chat_seat(doc, identity, watchers)?;
    let text = normalize(text, CHAT_MAX_LENGTH)
        .ok_or_else(|| SessionError::new(ErrorStatus::BadRequest, format!("A message needs 1 to {CHAT_MAX_LENGTH} characters.")))?;
    let mut next = doc.clone();
    let id = next.next_chat_id();
    next.push_chat(ChatEntry::Message { id, from, text: text.to_owned(), at: now, by: author.map(str::to_owned) });
    Ok(next)
}

fn chat_seat(doc: &SessionDoc, identity: &Identity, watchers: &[OpenWatcher]) -> Rule<ChatFrom> {
    if let Some(&seat) = doc.seats_of(identity).first() {
        return Ok(seat.into());
    }
    if !watchers.iter().any(|watcher| identity.contains(&watcher.token)) {
        return Err(SessionError::new(ErrorStatus::Forbidden, "Open the game to chat."));
    }
    if !doc.watcher_chat {
        return Err(SessionError::new(ErrorStatus::Forbidden, "The players turned off chat for watchers."));
    }
    Ok(ChatFrom::Watcher)
}

/// A request of a player for the sound playoff of the session (src/practice/playoff.ts).
pub fn playoff(doc: &SessionDoc, identity: &Identity, request: PlayoffRequest, now: EpochMs) -> Rule {
    let seat = doc.first_seat(identity)?;
    let both_seated = doc.seats.x.is_some() && doc.seats.o.is_some();
    let mut next = doc.clone();
    next.playoff = apply_playoff(doc.playoff.as_ref(), seat, both_seated, request, now)?;
    Ok(next)
}

// ---- Seats ----

/// The token of a watcher that is here now and holds no seat.
fn watcher_token(doc: &SessionDoc, watchers: &[OpenWatcher], id: &str) -> Rule<String> {
    let found = watchers
        .iter()
        .find(|watcher| watcher.id == id)
        .ok_or_else(|| SessionError::new(ErrorStatus::NotFound, "That watcher is not here any more."))?;
    if doc.seats.x.as_ref() == Some(&found.token) || doc.seats.o.as_ref() == Some(&found.token) {
        return Err(SessionError::conflict("That watcher has a seat now."));
    }
    Ok(found.token.clone())
}

/// Why `from` cannot take back the last move of the live game now, or None when it can.
fn undo_problem(doc: &SessionDoc, from: Player) -> Option<&'static str> {
    let game = doc.current_game();
    if !game.is_playing() {
        return Some("This game is over.");
    }
    if game.moves.is_empty() || game.turn == from {
        return Some("Only your own last move can go back, before the other player moves.");
    }
    if game.clock != NO_LIMIT {
        return Some("A timed game has no undo.");
    }
    if doc.is_locked() {
        return Some("Settings are locked until this game ends.");
    }
    None
}

/// Every applied change closes an open request, because the request was about the state before it.
/// A change of who holds a seat also ends a sound playoff: the playoff is stored by seat. A swap keeps
/// the same two players, so the playoff goes on with them.
/// Limit: the next playoff starts again at id 1, so a late request for the ended playoff can reach it.
/// Revisit this if a stale hit ever shows in a new playoff: then keep a playoff counter in the document.
fn apply_seat_change(doc: &SessionDoc, kind: SeatKind, from: Player, watcher: Option<String>) -> Rule {
    let mut next = match kind {
        SeatKind::Undo => {
            if let Some(problem) = undo_problem(doc, from) {
                return Err(SessionError::conflict(problem));
            }
            doc.replace_current(&doc.current_game().undo(1))
        }
        SeatKind::Swap => doc.swap_seats(),
        SeatKind::Leave | SeatKind::Unseat => {
            let seat = if kind == SeatKind::Leave { from } else { from.other() };
            let mut next = doc.clone();
            next.seats.set(seat, None);
            next.playoff = None;
            next
        }
        SeatKind::Give | SeatKind::Seat | SeatKind::Replace => {
            let watcher = watcher.unwrap_or_else(|| panic!("{kind:?} without a watcher"));
            let seat = if kind == SeatKind::Give { from } else { from.other() };
            let mut next = doc.clone();
            next.seats.set(seat, Some(watcher));
            next.playoff = None;
            next
        }
    };
    next.seat_request = None;
    Ok(next.log_events(vec![SessionEvent::Seat { action: kind }]))
}

/// A seated player changes the seats, or takes back the own last move (undo). A change of the other
/// player's seat or game becomes a request that the other player must accept. A change of the own
/// seat, or of an empty seat, applies at once.
pub fn seat(doc: &SessionDoc, identity: &Identity, request: &SeatAction, watchers: &[OpenWatcher], now: EpochMs) -> Rule {
    let from = doc.first_seat(identity)?;
    let other_token = doc.seats.get(from.other()).clone();
    if doc.open_request(now).is_some_and(|open| open.from == from.other()) {
        return Err(SessionError::conflict("Answer the request of the other player first."));
    }
    let watcher = request.watcher().map(|id| watcher_token(doc, watchers, id)).transpose()?;
    match request {
        SeatAction::Seat { .. } if other_token.is_some() => return Err(SessionError::conflict("The other seat is taken.")),
        SeatAction::Unseat | SeatAction::Replace { .. } if other_token.is_none() => {
            return Err(SessionError::conflict("The other seat is empty."));
        }
        SeatAction::Undo => {
            if let Some(problem) = undo_problem(doc, from) {
                return Err(SessionError::conflict(problem));
            }
        }
        _ => {}
    }
    // A player who holds both seats (two devices of one account) asks nobody.
    if let (Some(kind), Some(token)) = (request.consent(), &other_token)
        && !identity.contains(token)
    {
        let mut next = doc.clone();
        next.seat_request = Some(SeatRequest { kind, from, watcher, at: now });
        return Ok(next);
    }
    apply_seat_change(doc, request.kind(), from, watcher)
}

/// The other player accepts or declines an open request. The player who asked can only cancel it
/// (accept: false). Accept checks again that the change still applies, and then applies it.
pub fn answer_seat(doc: &SessionDoc, identity: &Identity, accept: bool, watchers: &[OpenWatcher], now: EpochMs) -> Rule {
    let seats = doc.require_seat(identity)?;
    let request =
        doc.open_request(now).ok_or_else(|| SessionError::conflict("There is no open request. It ended or somebody answered it."))?;
    let mut declined = doc.clone();
    declined.seat_request = None;
    if !seats.contains(&request.from.other()) {
        if accept {
            return Err(SessionError::conflict("Only the other player can accept this request."));
        }
        return Ok(declined);
    }
    if !accept {
        return Ok(declined);
    }
    if doc.seats.x.is_none() || doc.seats.o.is_none() {
        return Err(SessionError::conflict("The seats changed. The request no longer applies."));
    }
    if let Some(token) = &request.watcher {
        let here = watchers
            .iter()
            .any(|watcher| &watcher.token == token && doc.seats.x.as_ref() != Some(token) && doc.seats.o.as_ref() != Some(token));
        if !here {
            return Err(SessionError::conflict("That watcher left. Decline the request, or wait until it ends."));
        }
    }
    apply_seat_change(doc, request.kind.into(), request.from, request.watcher.clone())
}

/// Records a timeout that happened since the last change, and drops a seat request that ended.
/// None when there is nothing to record. The holder of the session calls this on every read.
pub fn settle(doc: &SessionDoc, now: EpochMs) -> Option<SessionDoc> {
    let game = doc.current_game();
    let flagged = is_flagged(&game, now);
    let request_ended = doc.seat_request.is_some() && doc.open_request(now).is_none();
    if !flagged && !request_ended {
        return None;
    }
    let mut next = if flagged { doc.replace_current(&game.time_out()) } else { doc.clone() };
    if request_ended {
        next.seat_request = None;
    }
    Some(next)
}

// ---- View ----

/// Who has the session open, as its holder knows it. `name` gives the display name of a token, and
/// `person` its public person id, or None when the holder has none yet.
pub struct Audience<'a> {
    pub presence: PerPlayer<bool>,
    pub watchers: &'a [OpenWatcher],
    pub name: &'a dyn Fn(&str) -> String,
    pub person: &'a dyn Fn(&str) -> Option<String>,
}

pub struct ViewContext<'a> {
    pub code: &'a str,
    pub version: u64,
    pub identity: &'a Identity,
    pub now: EpochMs,
    pub audience: Audience<'a>,
    pub players: PerPlayer<Option<PlayerInfo>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WatcherView {
    pub id: String,
    pub name: String,
    pub player: Option<PlayerInfo>,
    pub person: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RequestWatcherView {
    pub name: String,
    pub player: Option<PlayerInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatRequestView {
    pub kind: ConsentAction,
    pub from: Player,
    pub watcher: Option<RequestWatcherView>,
    pub expires_at: EpochMs,
}

/// What a page sees of a session (SessionView in src/protocol.ts). It holds no player token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub code: String,
    pub name: String,
    pub games: Vec<GameRecord>,
    pub seats: PerPlayer<bool>,
    pub you: Option<Player>,
    pub options: MatchOptions,
    pub locked: bool,
    pub clock: TimeControl,
    pub fixed_seats: bool,
    pub watcher_chat: bool,
    pub flipped: Vec<bool>,
    pub now: EpochMs,
    pub version: u64,
    pub chat: Vec<ChatEntry>,
    pub presence: PerPlayer<bool>,
    pub players: PerPlayer<Option<PlayerInfo>>,
    pub names: PerPlayer<Option<String>>,
    pub people: PerPlayer<Option<String>>,
    pub watchers: Vec<WatcherView>,
    pub you_watcher: Option<String>,
    pub seat_request: Option<SeatRequestView>,
    pub turn: Option<Player>,
    pub status: Status,
    pub playoff: Option<Playoff>,
}

/// The token of a seated person: None for an empty seat and for the computer.
fn human(token: &Option<String>) -> Option<&str> {
    token.as_deref().filter(|&token| token != COMPUTER_TOKEN)
}

pub fn view_of(doc: &SessionDoc, context: ViewContext) -> SessionView {
    let ViewContext { code, version, identity, now, audience, players } = context;
    let Audience { presence, watchers, name, person } = audience;
    let live = doc.current_game();
    let seat_name = |token: &Option<String>| human(token).map(name);
    let seat_person = |token: &Option<String>| human(token).and_then(person);
    let seat_request = doc.open_request(now).map(|request| SeatRequestView {
        kind: request.kind,
        from: request.from,
        watcher: request.watcher.as_ref().map(|token| RequestWatcherView {
            name: name(token),
            player: watchers.iter().find(|watcher| &watcher.token == token).and_then(|watcher| watcher.player.clone()),
        }),
        expires_at: request.at + SEAT_REQUEST_MS,
    });
    SessionView {
        code: code.to_owned(),
        name: doc.name.clone(),
        games: doc.games.clone(),
        seats: PerPlayer { x: doc.seats.x.is_some(), o: doc.seats.o.is_some() },
        you: doc.seats_of(identity).first().copied(),
        options: doc.options,
        locked: doc.is_locked(),
        clock: doc.clock,
        fixed_seats: doc.fixed_seats,
        watcher_chat: doc.watcher_chat,
        flipped: doc.flipped.clone(),
        now,
        version,
        chat: doc.chat.clone(),
        presence,
        players,
        names: PerPlayer { x: seat_name(&doc.seats.x), o: seat_name(&doc.seats.o) },
        people: PerPlayer { x: seat_person(&doc.seats.x), o: seat_person(&doc.seats.o) },
        watchers: watchers
            .iter()
            .map(|watcher| WatcherView {
                id: watcher.id.clone(),
                name: name(&watcher.token),
                player: watcher.player.clone(),
                person: person(&watcher.token),
            })
            .collect(),
        you_watcher: watchers.iter().find(|watcher| identity.contains(&watcher.token)).map(|watcher| watcher.id.clone()),
        seat_request,
        turn: live.is_playing().then_some(live.turn),
        status: live.status,
        playoff: doc.playoff.clone(),
    }
}

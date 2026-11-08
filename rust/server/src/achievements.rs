//! Achievements: goals that a player reaches over their finished games. A copy of the rules in src/achievements.ts.
//! achievement-cases.json (contract/achievement-cases.ts) holds the progress that the TypeScript rules give, and a test
//! here replays it, so the two copies cannot drift. Only the ids and the goals live here: the page holds the texts.
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use tick3d_core::clock::remaining;
use tick3d_core::game::{CELL_COUNT, Cell, EpochMs, Game, LineKind, Player, Status, line_kind, replay, winning_line};
use tick3d_core::session::{GameRecord, MatchOptions};

use crate::error::{ApiError, ApiResult};
use crate::protocol::{Difficulty, GameMode, has_result};

/// How the player placed their moves, from the metrics of their device.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct InputCounts {
    pub board: u64,
    pub keypad: u64,
    pub voice: u64,
}

/// One finished game of the player (AchievementGame in src/achievements.ts).
#[derive(Clone, Debug)]
#[cfg_attr(test, derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub struct AchievementGame {
    /// None for a game from before game links.
    pub id: Option<String>,
    pub mode: GameMode,
    pub game: GameRecord,
    /// The seat of the player. None when the player held both seats, as in a friend game.
    pub you: Option<Player>,
    pub difficulty: Option<Difficulty>,
    pub options: MatchOptions,
    pub tuned: bool,
    pub finished_at: EpochMs,
    /// A key of the person in the other seat of an online or Nearby game.
    pub opponent: Option<String>,
    pub input: Option<InputCounts>,
    /// The first invite from the player to the opponent, and from the opponent to the player.
    pub invited_opponent_at: Option<EpochMs>,
    pub invited_by_opponent_at: Option<EpochMs>,
}

/// The people who got the game through an invite, each person once, as the time when they got it.
#[derive(Clone, Debug, Default)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct Invites {
    pub direct: Vec<EpochMs>,
    pub second: Vec<EpochMs>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Won,
    Lost,
    Drawn,
}

/// The opponent: a computer level, or a person online or in Nearby.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    Computer(Difficulty),
    Person,
}

/// A game with its replayed end, which the rules read.
struct Played<'a> {
    game: &'a AchievementGame,
    end: Game,
    outcome: Outcome,
    level: Option<Level>,
    /// The outcomes of the earlier games against the same opponent, oldest first.
    rivalry: Vec<Outcome>,
}

type Test = fn(&Played) -> bool;

#[derive(Clone, Copy)]
enum Reach {
    Direct,
    Second,
}

#[derive(Clone, Copy)]
enum Kind {
    Count(Test),
    Streak { among: Test, test: Test },
    Invites(Reach),
}

pub struct Rule {
    pub id: &'static str,
    goal: usize,
    kind: Kind,
}

fn won(game: &Played) -> bool {
    game.outcome == Outcome::Won
}
fn lost(game: &Played) -> bool {
    game.outcome == Outcome::Lost
}
fn won_by_line(game: &Played) -> bool {
    won(game) && matches!(game.end.status, Status::Won { .. })
}
/// A computer game at this level or a harder one.
fn at_least(game: &Played, level: Difficulty) -> bool {
    matches!(game.level, Some(Level::Computer(played)) if played >= level)
}
fn won_at_least(game: &Played, level: Difficulty) -> bool {
    won(game) && at_least(game, level)
}
fn against_computer(game: &Played) -> bool {
    matches!(game.level, Some(Level::Computer(_)))
}
fn against_person(game: &Played) -> bool {
    game.level == Some(Level::Person)
}
/// An invite that came before this game.
fn invited_before(game: &Played, at: Option<EpochMs>) -> bool {
    at.is_some_and(|at| at < game.game.finished_at)
}
/// The fewest moves of a win: 4 marks of X, with 3 marks of O between them.
const FASTEST_WIN: usize = 7;
fn fastest(game: &Played) -> bool {
    won_by_line(game) && game.game.game.moves.len() == FASTEST_WIN
}
fn won_line(game: &Played) -> Option<[Cell; 4]> {
    match game.end.status {
        Status::Won { line, .. } if won(game) => Some(line),
        _ => None,
    }
}
fn space_diagonal(game: &Played) -> bool {
    won_line(game).is_some_and(|line| line_kind(&line) == LineKind::Space)
}
/// A straight line down through all 4 floors: only the floor changes along it.
fn elevator(game: &Played) -> bool {
    won_line(game).is_some_and(|line| {
        let [a, b] = [line[0].coords(), line[1].coords()];
        a[1] == b[1] && a[2] == b[2]
    })
}
fn has_limit(game: &Played) -> bool {
    let clock = game.game.game.clock;
    clock.per_move.is_some() || clock.per_game.is_some()
}
fn limit_at_most(game: &Played, per_move: u32, per_game: u32) -> bool {
    let clock = game.game.game.clock;
    clock.per_move.is_some_and(|limit| limit <= per_move) || clock.per_game.is_some_and(|limit| limit <= per_game)
}
/// Less than this many milliseconds on the clock of the winner after the winning move.
const PHOTO_FINISH_MS: i64 = 1000;
fn photo_finish(game: &Played) -> bool {
    let (Some(you), true) = (game.game.you, won_line(game).is_some()) else { return false };
    let times = &game.end.times;
    let Some(clocks) = remaining(&game.end, times.last().copied().unwrap_or(game.game.finished_at)) else { return false };
    // remaining() keeps the move clock of a finished game full, so the winning move counts here.
    let at = |back: usize| times.len().checked_sub(back).map_or(0, |i| times[i]);
    let last_move = at(1) - at(2);
    let move_left = game.end.clock.per_move.map_or(i64::MAX, |seconds| i64::from(seconds) * 1000 - last_move);
    clocks.get(you).game.unwrap_or(i64::MAX).min(move_left) < PHOTO_FINISH_MS
}
/// The move of the winner before the winning move left two cells to win on.
fn fork(game: &Played) -> bool {
    let Status::Won { winner, .. } = game.end.status else { return false };
    if !won(game) {
        return false;
    }
    let moves = &game.end.moves;
    let before = replay(&moves[..moves.len() - 2], Player::X, None, game.end.clock).expect("a part of a played game replays").board;
    (0..CELL_COUNT)
        .map(|index| Cell::try_from(u8::try_from(index).expect("a cell index fits in u8")).expect("a cell index is a cell"))
        .filter(|cell| before[cell.index()].is_none())
        .filter(|&cell| {
            let mut board = before;
            board[cell.index()] = Some(winner);
            winning_line(&board, cell, winner).is_some()
        })
        .count()
        >= 2
}
fn first_meeting(game: &Played) -> bool {
    game.game.opponent.is_some() && game.rivalry.is_empty()
}

use Difficulty::{Easy, Hard, Medium};

const fn count(id: &'static str, goal: usize, test: Test) -> Rule {
    Rule { id, goal, kind: Kind::Count(test) }
}
const fn streak(id: &'static str, goal: usize, among: Test, test: Test) -> Rule {
    Rule { id, goal, kind: Kind::Streak { among, test } }
}
const fn invites(id: &'static str, goal: usize, reach: Reach) -> Rule {
    Rule { id, goal, kind: Kind::Invites(reach) }
}

/// ACHIEVEMENTS in src/achievements.ts, in the same order.
pub static RULES: [Rule; 54] = [
    count("first-win", 1, won),
    count("games-10", 10, |_| true),
    count("games-100", 100, |_| true),
    count("beat-easy", 1, |g| won_at_least(g, Easy)),
    count("beat-medium", 1, |g| won_at_least(g, Medium)),
    count("beat-hard", 1, |g| won_at_least(g, Hard)),
    count("fastest-easy", 1, |g| fastest(g) && at_least(g, Easy)),
    count("fastest-medium", 1, |g| fastest(g) && at_least(g, Medium)),
    count("fastest-person", 1, |g| fastest(g) && against_person(g)),
    count("space-diagonal-easy", 1, |g| space_diagonal(g) && at_least(g, Easy)),
    count("space-diagonal-medium", 1, |g| space_diagonal(g) && at_least(g, Medium)),
    count("space-diagonal-hard", 1, |g| space_diagonal(g) && at_least(g, Hard)),
    count("space-diagonal-person", 1, |g| space_diagonal(g) && against_person(g)),
    count("board-hidden-easy", 1, |g| won_at_least(g, Easy) && g.game.options.hide_board),
    count("board-hidden-medium", 1, |g| won_at_least(g, Medium) && g.game.options.hide_board),
    count("board-hidden-hard", 1, |g| won_at_least(g, Hard) && g.game.options.hide_board),
    count("board-hidden-person", 1, |g| won(g) && against_person(g) && g.game.options.hide_board),
    streak("computer-streak-easy-5", 5, against_computer, |g| won_at_least(g, Easy)),
    streak("computer-streak-medium-3", 3, against_computer, |g| won_at_least(g, Medium)),
    streak("computer-streak-medium-5", 5, against_computer, |g| won_at_least(g, Medium)),
    streak("computer-streak-medium-10", 10, against_computer, |g| won_at_least(g, Medium)),
    streak("computer-streak-hard-2", 2, against_computer, |g| won_at_least(g, Hard)),
    streak("computer-streak-hard-5", 5, against_computer, |g| won_at_least(g, Hard)),
    streak("streak-3", 3, against_person, won),
    streak("streak-5", 5, against_person, won),
    count("timed-win", 1, |g| won(g) && has_limit(g)),
    count("timed-win-short", 1, |g| won(g) && g.game.you.is_some() && limit_at_most(g, 10, 120)),
    count("timed-win-bullet", 1, |g| won(g) && g.game.you.is_some() && limit_at_most(g, 5, 60)),
    count("won-on-time", 1, |g| won(g) && against_person(g) && matches!(g.end.status, Status::Timeout { .. })),
    count("o-win-medium", 1, |g| g.game.you == Some(Player::O) && won_at_least(g, Medium)),
    count("o-win-hard", 1, |g| g.game.you == Some(Player::O) && won_at_least(g, Hard)),
    count("o-win-person", 1, |g| g.game.you == Some(Player::O) && won(g) && against_person(g)),
    count("online-win", 1, |g| won(g) && g.game.mode == GameMode::Online),
    count("nearby-win", 1, |g| won(g) && g.game.mode == GameMode::Nearby),
    // Each first game against a new opponent counts once.
    count("people-5", 5, first_meeting),
    count("people-20", 20, first_meeting),
    count("friend-game", 1, |g| g.game.mode == GameMode::Friend),
    streak("friend-streak-5", 5, |_| true, |g| g.game.mode == GameMode::Friend),
    count("coordinates-hidden", 1, |g| won(g) && g.game.options.hide_coordinates),
    count("elevator", 1, elevator),
    count("fork", 1, |g| fork(g) && (at_least(g, Medium) || against_person(g))),
    count("full-cube", 1, |g| g.end.status == Status::Draw),
    // Limit: an online game has no metrics in its result, so only a computer game counts (as in src/achievements.ts).
    count("sound-only", 1, |g| {
        won(g)
            && g.level == Some(Level::Computer(Hard))
            && g.game.options.hide_board
            && g.game.input.is_some_and(|input| input.board == 0 && input.voice > 0 && input.voice == input.keypad)
    }),
    count("nemesis", 1, |g| lost(g) && g.rivalry.len() >= 2 && g.rivalry[g.rivalry.len() - 2..].iter().all(|&o| o == Outcome::Lost)),
    count("revenge", 1, |g| won(g) && g.rivalry.last() == Some(&Outcome::Lost)),
    count("lost-to-easy", 1, |g| lost(g) && g.level == Some(Level::Computer(Easy))),
    count("photo-finish", 1, photo_finish),
    count("last-move", 1, |g| won_by_line(g) && g.end.moves.len() == CELL_COUNT),
    invites("invite-1", 1, Reach::Direct),
    invites("invite-5", 5, Reach::Direct),
    invites("invite-25", 25, Reach::Direct),
    invites("family-tree", 1, Reach::Second),
    count("beaten-by-invitee", 1, |g| lost(g) && against_person(g) && invited_before(g, g.game.invited_opponent_at)),
    count("beat-inviter", 1, |g| won(g) && against_person(g) && invited_before(g, g.game.invited_by_opponent_at)),
];

/// Raise it with ACHIEVEMENT_RULES_VERSION in contract/achievement-cases.ts when a rule changes. The signatures of
/// achievement_players read it (the cases test checks that both are the same).
pub const RULES_VERSION: u32 = 5;

/// The rules of the signatures: the version and every id.
pub fn rules_value() -> String {
    let ids: Vec<&str> = RULES.iter().map(|rule| rule.id).collect();
    format!("{RULES_VERSION} {}", ids.join(" "))
}

pub fn is_id(id: &str) -> bool {
    RULES.iter().any(|rule| rule.id == id)
}

/// How far the player is with one achievement. `count` stops at the goal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: &'static str,
    pub count: usize,
    pub unlocked_at: Option<EpochMs>,
    pub unlocked_by: Option<String>,
}

/// How many players unlocked each achievement, out of every player with a finished game.
#[derive(Clone, Debug, Serialize)]
pub struct Rarity {
    pub players: u64,
    pub unlocked: BTreeMap<&'static str, u64>,
}

impl Rarity {
    /// Every id once, with the counts of `found` and 0 for the rest. An unknown id in `found` is a fault.
    pub fn of(players: u64, found: HashMap<String, u64>) -> ApiResult<Rarity> {
        if let Some(unknown) = found.keys().find(|id| !is_id(id)) {
            return Err(ApiError::fault(format!("achievement_players holds the unknown achievement {unknown}")));
        }
        Ok(Rarity { players, unlocked: RULES.iter().map(|rule| (rule.id, found.get(rule.id).copied().unwrap_or(0))).collect() })
    }
}

/// The answer of GET /api/me/achievements, and the achievements of a person on the stats page.
#[derive(Clone, Debug, Serialize)]
pub struct Achievements {
    pub achievements: Vec<Progress>,
    pub rarity: Rarity,
}

/// The progress of every achievement, in the order of RULES. The games can come in any order.
pub fn achievement_progress(games: &[AchievementGame], invites: &Invites) -> ApiResult<Vec<Progress>> {
    let mut sorted: Vec<&AchievementGame> = games.iter().collect();
    // Oldest first, then by id with a game without one first, as byFinish in src/achievements.ts.
    sorted.sort_by(|a, b| a.finished_at.cmp(&b.finished_at).then_with(|| a.id.cmp(&b.id)));
    let mut rivalries: HashMap<&str, Vec<Outcome>> = HashMap::new();
    let mut played = Vec::with_capacity(sorted.len());
    for game in sorted {
        let end = game.game.to_game();
        if !has_result(&end.status) {
            return Err(ApiError::fault("an achievement game has no result"));
        }
        let winner = match end.status {
            Status::Won { winner, .. } | Status::Timeout { winner } => Some(winner),
            _ => None,
        };
        let outcome = match (game.you, winner) {
            // The player of a friend game held both seats, so a win of either seat is their win.
            (None, None) | (Some(_), None) => Outcome::Drawn,
            (None, Some(_)) => Outcome::Won,
            (Some(you), Some(winner)) => {
                if you == winner {
                    Outcome::Won
                } else {
                    Outcome::Lost
                }
            }
        };
        let rivalry = match &game.opponent {
            None => Vec::new(),
            Some(opponent) => {
                let earlier = rivalries.entry(opponent.as_str()).or_default();
                let before = earlier.clone();
                earlier.push(outcome);
                before
            }
        };
        played.push(Played { game, end, outcome, level: level_of(game), rivalry });
    }
    let mut direct = invites.direct.clone();
    direct.sort_unstable();
    let mut second = invites.second.clone();
    second.sort_unstable();
    Ok(RULES
        .iter()
        .map(|rule| match rule.kind {
            Kind::Invites(reach) => invite_progress(rule, if matches!(reach, Reach::Direct) { &direct } else { &second }),
            Kind::Count(test) => progress_of(rule, &played, |_| true, test, false),
            Kind::Streak { among, test } => progress_of(rule, &played, among, test, true),
        })
        .collect())
}

/// `invited` is sorted, oldest first. The person who reached the goal unlocks it, so no game does.
fn invite_progress(rule: &Rule, invited: &[EpochMs]) -> Progress {
    Progress { id: rule.id, count: invited.len().min(rule.goal), unlocked_at: invited.get(rule.goal - 1).copied(), unlocked_by: None }
}

fn level_of(game: &AchievementGame) -> Option<Level> {
    game.you?;
    match game.mode {
        GameMode::Online | GameMode::Nearby => Some(Level::Person),
        // A tuned computer plays another game, so it counts for no level.
        GameMode::Computer if !game.tuned => game.difficulty.map(Level::Computer),
        _ => None,
    }
}

fn progress_of(rule: &Rule, games: &[Played], among: Test, test: Test, is_streak: bool) -> Progress {
    let mut best = 0;
    let mut run = 0;
    let mut unlocked: Option<&Played> = None;
    for game in games {
        if is_streak {
            if !among(game) {
                continue;
            }
            run = if test(game) { run + 1 } else { 0 };
            best = best.max(run);
        } else if test(game) {
            best += 1;
        }
        if unlocked.is_none() && best >= rule.goal {
            unlocked = Some(game);
        }
    }
    Progress {
        id: rule.id,
        count: best.min(rule.goal),
        unlocked_at: unlocked.map(|game| game.game.finished_at),
        unlocked_by: unlocked.and_then(|game| game.game.id.clone()),
    }
}

/// One event that got the game to somebody through an invite.
/// `keys` name the human behind it. Events that share a key belong to one person.
pub struct InviteEvent {
    pub keys: Vec<String>,
    pub at: EpochMs,
}

/// The first time of each person, after a merge of the events that share a key.
pub fn people_of(events: &[InviteEvent]) -> Vec<EpochMs> {
    fn find(parent: &mut HashMap<String, String>, key: &str) -> String {
        match parent.get(key).cloned() {
            Some(up) if up != key => {
                let root = find(parent, &up);
                parent.insert(key.to_owned(), root.clone());
                root
            }
            _ => key.to_owned(),
        }
    }
    let first_key = |event: &InviteEvent| event.keys.first().cloned().expect("an invite event has a key");
    let mut parent: HashMap<String, String> = HashMap::new();
    for event in events {
        let root = find(&mut parent, &first_key(event));
        for key in &event.keys {
            let other = find(&mut parent, key);
            if other != root {
                parent.insert(other, root.clone());
            }
        }
    }
    // The roots in the order of their first event.
    let mut first: Vec<(String, EpochMs)> = Vec::new();
    for event in events {
        let root = find(&mut parent, &first_key(event));
        match first.iter_mut().find(|(known, _)| *known == root) {
            Some((_, at)) => *at = (*at).min(event.at),
            None => first.push((root, event.at)),
        }
    }
    first.into_iter().map(|(_, at)| at).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Rule {
        id: String,
        goal: usize,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        games: Vec<AchievementGame>,
        invites: Invites,
        progress: Vec<serde_json::Value>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cases {
        rules_version: u32,
        rules: Vec<Rule>,
        cases: Vec<Case>,
    }

    #[test]
    fn gives_the_progress_of_the_typescript_rules() {
        let cases: Cases = serde_json::from_str(include_str!("../achievement-cases.json")).expect("the cases parse");
        assert_eq!(cases.rules_version, RULES_VERSION);
        let ours: Vec<(&str, usize)> = RULES.iter().map(|rule| (rule.id, rule.goal)).collect();
        let theirs: Vec<(&str, usize)> = cases.rules.iter().map(|rule| (rule.id.as_str(), rule.goal)).collect();
        assert_eq!(ours, theirs);
        for (index, case) in cases.cases.iter().enumerate() {
            let progress = achievement_progress(&case.games, &case.invites).expect("the games have results");
            assert_eq!(
                serde_json::to_value(&progress).expect("progress serializes"),
                serde_json::Value::from(case.progress.clone()),
                "case {index}"
            );
        }
    }

    #[test]
    fn counts_each_person_of_the_invites_once() {
        let event = |keys: &[&str], at| InviteEvent { keys: keys.iter().map(|key| (*key).to_owned()).collect(), at };
        // A claim in the browser, then the app on the same phone (same token), then the same person on a laptop (same owner).
        let events = [event(&["t:a", "o:a"], 30), event(&["t:a"], 10), event(&["t:b", "o:a"], 20), event(&["e:x@y"], 50)];
        assert_eq!(people_of(&events), vec![10, 50]);
    }
}

// Time limits, like a chess clock. A copy of the rules in src/clock.ts.
use serde::{Deserialize, Serialize};

use crate::game::{EpochMs, Game, PerPlayer, Player};

/// Seconds, or None for no limit of that kind. With both limits, the first one to run out decides.
/// Limit: Deserialize checks the shape only, not LIMIT_RANGE in src/clock.ts. Revisit when the Rust
/// server reads clocks from requests or stored documents: then add the range check there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeControl {
    pub per_move: Option<u32>,
    pub per_game: Option<u32>,
}

pub const NO_LIMIT: TimeControl = TimeControl { per_move: None, per_game: None };

/// Milliseconds a player has: on the game limit, on the move limit, and the smaller one that decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlayerClock {
    pub left: i64,
    pub game: Option<i64>,
    pub per_move: Option<i64>,
}

/// The clock of each player at `now`, or None when the game has no limit.
/// The first move of each player is untimed, so the clocks start once both players moved once.
pub fn remaining(game: &Game, now: EpochMs) -> Option<PerPlayer<PlayerClock>> {
    let TimeControl { per_move, per_game } = game.clock;
    if per_move.is_none() && per_game.is_none() {
        return None;
    }
    let full_bank = per_game.map(|seconds| i64::from(seconds) * 1000);
    let mut bank = PerPlayer { x: full_bank, o: full_bank };
    let mover = |i: usize| if i.is_multiple_of(2) { game.first } else { game.first.other() };
    for i in 2..game.moves.len() {
        let spent = game.times[i] - game.times[i - 1];
        if let Some(before) = *bank.get(mover(i)) {
            bank.set(mover(i), Some(before - spent));
        }
    }
    let live = game.is_playing() && game.moves.len() >= 2;
    let running = match game.times.last() {
        Some(&last) if live => now - last,
        _ => 0,
    };
    let clock_of = |player: Player| {
        let used = if live && game.turn == player { running } else { 0 };
        let game_left = bank.get(player).map(|left| left - used);
        let move_left = per_move.map(|seconds| i64::from(seconds) * 1000 - used);
        let left = game_left.unwrap_or(i64::MAX).min(move_left.unwrap_or(i64::MAX));
        let timed_out = matches!(game.status, crate::game::Status::Timeout { winner } if winner != player);
        PlayerClock { left: if timed_out { 0 } else { left }, game: game_left, per_move: move_left }
    };
    Some(PerPlayer { x: clock_of(Player::X), o: clock_of(Player::O) })
}

pub fn is_flagged(game: &Game, now: EpochMs) -> bool {
    game.is_playing() && remaining(game, now).is_some_and(|clocks| clocks.get(game.turn).left <= 0)
}

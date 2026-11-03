// A sound playoff inside an online session. A copy of `applyPlayoff` in src/practice/playoff.ts.
use serde::{Deserialize, Serialize};

use crate::game::{PerPlayer, Player};
use crate::session::SessionError;

/// The countdown after both players joined, so both pages start together.
pub const PLAYOFF_COUNTDOWN_MS: i64 = 3000;
/// ROUNDS.targets in src/practice/practice.ts.
pub const PLAYOFF_TARGETS: usize = 10;
/// MAX_ROUND_MS in src/practice/practice.ts.
pub const MAX_ROUND_MS: i64 = 120_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetId {
    Easy,
    Normal,
    Hard,
}

/// `times` holds the time of each target that the player hit, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayoffSeat {
    pub joined: bool,
    pub times: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayoffEnd {
    /// Both players finished.
    Done,
    /// The other player said not now.
    Declined,
    /// A player stopped.
    Left,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playoff {
    /// Grows with each playoff of the session, so a late request for an older playoff does nothing.
    pub id: u64,
    pub seed: u32,
    pub preset: PresetId,
    pub by: Player,
    pub seats: PerPlayer<PlayoffSeat>,
    /// Server time when the targets start, once both joined.
    pub start_at: Option<i64>,
    pub ended: Option<PlayoffEnd>,
}

impl Playoff {
    /// The same playoff with X and O traded: a seat swap keeps the same two players.
    pub fn swapped(&self) -> Playoff {
        Playoff { by: self.by.other(), seats: self.seats.clone().swapped(), ..self.clone() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum PlayoffRequest {
    Start { preset: PresetId, seed: u32 },
    Join { id: u64 },
    Leave { id: u64 },
    Hit { id: u64, index: usize, ms: u32 },
}

/// Applies one request of the player on `seat`. `both_seated` is true when both seats have a player.
/// Returns the playoff unchanged for a late request for an older playoff.
pub fn apply_playoff(
    playoff: Option<&Playoff>,
    seat: Player,
    both_seated: bool,
    request: PlayoffRequest,
    now: i64,
) -> Result<Option<Playoff>, SessionError> {
    let id = match request {
        PlayoffRequest::Start { preset, seed } => {
            if !both_seated {
                return Err(SessionError::conflict("A playoff needs a player on both seats."));
            }
            let runs = playoff.is_some_and(|old| {
                old.ended.is_none() && old.start_at.is_some_and(|start| now < start + PLAYOFF_TARGETS as i64 * MAX_ROUND_MS)
            });
            if runs {
                return Err(SessionError::conflict("A playoff runs now. Finish it or leave it first."));
            }
            let mut seats = PerPlayer::<PlayoffSeat>::default();
            seats.set(seat, PlayoffSeat { joined: true, times: vec![] });
            let id = playoff.map_or(0, |old| old.id) + 1;
            return Ok(Some(Playoff { id, seed, preset, by: seat, seats, start_at: None, ended: None }));
        }
        PlayoffRequest::Join { id } | PlayoffRequest::Leave { id } | PlayoffRequest::Hit { id, .. } => id,
    };
    let Some(current) = playoff else { return Ok(None) };
    if current.id != id || current.ended.is_some() {
        return Ok(Some(current.clone()));
    }
    let mine = current.seats.get(seat);
    let mut next = current.clone();
    match request {
        PlayoffRequest::Start { .. } => unreachable!("start returns above"),
        PlayoffRequest::Join { .. } => {
            if mine.joined {
                return Ok(Some(next));
            }
            next.seats.set(seat, PlayoffSeat { joined: true, ..mine.clone() });
            next.start_at = next.seats.get(seat.other()).joined.then_some(now + PLAYOFF_COUNTDOWN_MS);
        }
        PlayoffRequest::Leave { .. } => {
            next.ended = Some(if current.start_at.is_none() && !mine.joined { PlayoffEnd::Declined } else { PlayoffEnd::Left });
        }
        PlayoffRequest::Hit { index, ms, .. } => {
            if current.start_at.is_none_or(|start| now < start) {
                return Err(SessionError::conflict("The playoff has not started."));
            }
            // A repeat of a hit that the server has already is fine: the page sends again after a lost answer.
            if index < mine.times.len() {
                return Ok(Some(next));
            }
            if index != mine.times.len() {
                return Err(SessionError::conflict("A hit came out of order."));
            }
            let mut times = mine.times.clone();
            times.push(ms);
            next.seats.set(seat, PlayoffSeat { joined: mine.joined, times });
            let done = next.seats.x.times.len() == PLAYOFF_TARGETS && next.seats.o.times.len() == PLAYOFF_TARGETS;
            next.ended = done.then_some(PlayoffEnd::Done);
        }
    }
    Ok(Some(next))
}

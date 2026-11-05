//! Finished games from the devices and the metrics of online games (server/store.ts: addResults, addSeatMetrics).
use axum::http::StatusCode;
use serde_json::{Value, json};
use tick3d_core::game::{PerPlayer, Player};
use tokio::sync::oneshot;

use super::sessions::{QueuedResult, ResultOutcome, Row, is_finished};
use super::{Db, FROM_NODE, metric_lists, now_ms};
use crate::error::{ApiError, ApiResult};
use crate::protocol::{GameId, parse_result_upload};

/// One queued upload: its result id, the link that the device asked for, and the outcome of its batch.
pub struct QueuedUpload {
    pub id: String,
    pub asked: Option<String>,
    pub outcome: oneshot::Receiver<Result<ResultOutcome, String>>,
}

/// An upload that the server refuses, by its place in the request list, so the device stops sending it.
#[derive(Debug, PartialEq, Eq)]
pub struct RefusedUpload {
    pub index: usize,
    pub error: &'static str,
}

/// The seat tokens of a result from a device. Its player holds `you`, or both seats in a friend game.
/// A Nearby host also names the guest on the other seat.
fn seat_tokens(token: &str, you: Option<Player>, guest: Option<&str>) -> PerPlayer<Option<String>> {
    let holder = |seat: Player| if you == Some(seat.other()) { guest.map(str::to_owned) } else { Some(token.to_owned()) };
    PerPlayer { x: holder(Player::X), o: holder(Player::O) }
}

impl Db {
    /// Queues the finished games of one upload. The job answers after the batch that writes them. A result that is not
    /// valid is refused on its own, so one bad result never blocks the others of the device.
    pub fn add_results(&mut self, token: &str, uploads: &[Value]) -> (Vec<QueuedUpload>, Vec<RefusedUpload>) {
        let now = now_ms();
        let mut results = Vec::new();
        let mut refused = Vec::new();
        for (index, upload) in uploads.iter().enumerate() {
            match parse_result_upload(metric_lists(), upload, now) {
                None => refused.push(RefusedUpload { index, error: "A result is not a valid finished game." }),
                Some(result) if result.guest.as_deref() == Some(token) => {
                    refused.push(RefusedUpload { index, error: "The guest of a Nearby game needs its own player token." });
                }
                Some(result) => results.push(result),
            }
        }
        let queued = results
            .into_iter()
            .map(|result| {
                // The metrics go to their own column, and the guest's token to its seat column, not into the stored game.
                let stored = json!({
                    "id": result.id, "mode": result.mode, "game": result.game, "you": result.you, "difficulty": result.difficulty,
                    "finishedAt": result.finished_at, "options": result.options, "tuned": result.tuned,
                });
                let doc = move |public_id: &str| {
                    let mut doc = stored.clone();
                    doc["publicId"] = Value::from(public_id);
                    doc
                };
                let asked = result.public_id.clone();
                // An uploaded result id never holds ':', so this row is an upload and not an online game.
                let outcome = self.queue_result(QueuedResult {
                    id: result.id.clone(),
                    token: token.to_owned(),
                    doc: Box::new(doc),
                    finished_at: result.finished_at,
                    public_id: result.public_id,
                    renameable: true,
                    seats: seat_tokens(token, result.you, result.guest.as_deref()),
                    game: result.game,
                    metrics: result.metrics,
                });
                QueuedUpload { id: result.id, asked, outcome }
            })
            .collect();
        (queued, refused)
    }

    /// The finished game of an online id in its session, or a 404.
    pub(super) fn finished_online_game(&mut self, id: &GameId) -> ApiResult<(Row, usize)> {
        let not_found = || ApiError::new(StatusCode::NOT_FOUND, "No game with this link.");
        let GameId::Online { code, index } = id else { return Err(not_found()) };
        let row = match self.load_raw(code) {
            Ok(row) => row,
            Err(ApiError::Refusal { .. }) => return Err(not_found()),
            Err(fault) => return Err(fault),
        };
        if !row.doc.games.get(*index).is_some_and(is_finished) {
            return Err(not_found());
        }
        Ok((row, *index))
    }

    /// The metrics of one player's device for a finished online game. The first report per seat counts, so a page that
    /// sends again changes nothing. Returns false for a repeat.
    pub fn add_seat_metrics(&mut self, id: &GameId, token: &str, metrics: &Value) -> ApiResult<bool> {
        if matches!(id, GameId::Device(_)) {
            return Err(ApiError::bad_request("Only an online game takes metrics here. Other games send them with the result."));
        }
        let (row, index) = self.finished_online_game(id)?;
        let identity = self.identity_of(Some(token))?;
        let seat_now = *row
            .doc
            .seats_of(&identity)
            .first()
            .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "Only the two players can send metrics for this game."))?;
        // The seats rotate between games: the report counts for the seat that this player held in that game.
        let seat = if row.doc.flipped.get(index) == Some(&true) { seat_now.other() } else { seat_now };
        let seat = match seat {
            Player::X => "X",
            Player::O => "O",
        };
        let fields = &FROM_NODE.fields;
        let inserted = self.query(
            &format!(
                "INSERT INTO seat_metrics (public_id, seat, metrics, {}) VALUES ($id, $seat, $metrics::JSON::VARIANT, {})
                 ON CONFLICT DO NOTHING RETURNING seat",
                fields.metric_columns, fields.metric_values_of_parameter
            ),
            &[("id", &id.text()), ("seat", &seat), ("metrics", &metrics.to_string())],
            |row| row.get::<_, String>(0),
        )?;
        Ok(!inserted.is_empty())
    }
}

//! Delete my data (server/store.ts: deleteFor, deleteData, deletedSince). The comment above deleteFor in
//! server/store.ts lists what happens to each table.
use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use tick3d_core::session::{self, ChatEntry, SessionDoc};

use super::{Db, json_list, now_ms};
use crate::error::ApiResult;
use crate::ids::person_id;

/// The tables of the answer (DATA_TABLES in server/api-docs.ts).
const DATA_TABLES: [&str; 18] = [
    "sessions",
    "chat_messages",
    "results",
    "seat_metrics",
    "player_names",
    "blocks",
    "private_stats",
    "achievement_resets",
    "achievement_players",
    "seat_people",
    "practice_runs",
    "reports",
    "tester_codes",
    "app_copies",
    "apple_slots",
    "player_tokens",
    "users",
    "logins",
];
const DELETED_MESSAGE: &str = "Deleted by its author.";
/// DELETED_NAME in src/deletions.ts.
const DELETED_NAME: &str = "Deleted player";

#[derive(Clone, Copy, Default, Serialize)]
pub struct Counts {
    pub deleted: usize,
    pub anonymised: usize,
}

/// How many rows of each table went or lost the player.
#[derive(Serialize)]
pub struct DeletedData(BTreeMap<&'static str, Counts>);

impl DeletedData {
    fn new() -> DeletedData {
        DeletedData(DATA_TABLES.iter().map(|table| (*table, Counts::default())).collect())
    }

    fn of(&mut self, table: &str) -> &mut Counts {
        self.0.get_mut(table).unwrap_or_else(|| panic!("{table} is not in DATA_TABLES"))
    }
}

/// The deletion notices since `since`, and the server time of the answer for the next call.
#[derive(Serialize)]
pub struct DeletedSince {
    pub people: Vec<String>,
    pub until: i64,
}

impl Db {
    /// Delete my data for this device, and for the account when the device is logged in. `token` is a device token,
    /// or the account token of a maintainer request.
    /// Limit: the achievements are not ported yet. When they are, check every player again here, as deleteFor does.
    pub fn delete_for(&mut self, token: &str) -> ApiResult<DeletedData> {
        let identity = self.identity_of(Some(token))?;
        let own: Vec<String> = identity.iter().cloned().collect();
        let own_persons: HashSet<String> = own.iter().map(|owner| person_id(owner)).collect();
        let ids = json_list(&own);
        let persons = json_list(&own_persons.iter().cloned().collect::<Vec<_>>());
        let linked: Option<i64> = self
            .query("FROM player_tokens SELECT github_id WHERE token = $token", &[("token", &token)], |row| row.get(0))?
            .into_iter()
            .next();
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        match self.delete_in_transaction(&identity, &own_persons, &ids, &persons, linked) {
            Ok((counts, changed)) => {
                self.conn.execute_batch("COMMIT")?;
                for code in changed {
                    self.hooks.changed(&code);
                }
                Ok(counts)
            }
            Err(error) => {
                self.conn.execute_batch("ROLLBACK")?;
                self.tokens.after_write("ROLLBACK");
                Err(error)
            }
        }
    }

    fn delete_in_transaction(
        &mut self,
        identity: &session::Identity,
        own_persons: &HashSet<String>,
        ids: &str,
        persons: &str,
        account: Option<i64>,
    ) -> ApiResult<(DeletedData, Vec<String>)> {
        let mut counts = DeletedData::new();
        let mine = |seat: &Option<String>| seat.as_ref().is_some_and(|seat| identity.contains(seat));
        let wrote = |doc: &SessionDoc| {
            doc.chat.iter().any(|entry| matches!(entry, ChatEntry::Message { by: Some(by), .. } if own_persons.contains(by)))
        };
        // The sessions change in memory, outside the transaction: a rollback after them keeps the session changes,
        // which only take this player out, and a new request finds nothing more to change there.
        let saved: Vec<String> = self.query(
            "FROM sessions SELECT code
             WHERE list_contains(CAST($ids AS JSON)::VARCHAR[], doc.seats.X::VARCHAR) OR list_contains(CAST($ids AS JSON)::VARCHAR[], doc.seats.O::VARCHAR)
               OR list_contains(CAST($ids AS JSON)::VARCHAR[], doc.seatRequest.watcher::VARCHAR)
               OR list_has_any(CAST($persons AS JSON)::VARCHAR[], json_extract_string(doc::JSON, '$.chat[*].by'))",
            &[("ids", &ids), ("persons", &persons)],
            |row| row.get(0),
        )?;
        let held = self.sessions_where(saved, |doc| {
            mine(&doc.seats.x)
                || mine(&doc.seats.o)
                || mine(&doc.seat_request.as_ref().and_then(|request| request.watcher.clone()))
                || wrote(doc)
        })?;
        let mut changed = Vec::new();
        for row in held {
            let mut doc = row.doc.clone();
            let freed = mine(&doc.seats.x) || mine(&doc.seats.o);
            if mine(&doc.seats.x) {
                doc.seats.x = None;
            }
            if mine(&doc.seats.o) {
                doc.seats.o = None;
            }
            if freed || mine(&doc.seat_request.as_ref().and_then(|request| request.watcher.clone())) {
                doc.seat_request = None;
            }
            // The message keeps its id and seat, so the ids of later messages stay unique.
            for entry in &mut doc.chat {
                if let ChatEntry::Message { text, by, .. } = entry
                    && by.as_ref().is_some_and(|by| own_persons.contains(by))
                {
                    *text = DELETED_MESSAGE.to_owned();
                    *by = None;
                    counts.of("chat_messages").anonymised += 1;
                }
            }
            changed.push(row.code.clone());
            if doc.seats.x.is_none() && doc.seats.o.is_none() && session::is_empty_session(&row.doc) {
                self.delete_session(&row.code)?;
                counts.of("sessions").deleted += 1;
                continue;
            }
            self.save(&row, doc)?;
            counts.of("sessions").anonymised += 1;
        }

        let list = "CAST($ids AS JSON)::VARCHAR[]";
        let person_list = "CAST($persons AS JSON)::VARCHAR[]";
        let by_ids: &[(&str, &dyn duckdb::ToSql)] = &[("ids", &ids)];
        // Before the seats of the results change: a metrics row finds its player through them.
        counts.of("seat_metrics").deleted = self.execute(
            &format!(
                "DELETE FROM seat_metrics WHERE EXISTS (FROM results r SELECT 1 WHERE r.public_id = seat_metrics.public_id
                   AND ((seat_metrics.seat = 'X' AND list_contains({list}, r.player_x)) OR (seat_metrics.seat = 'O' AND list_contains({list}, r.player_o))))"
            ),
            by_ids,
        )?;
        // The games that this player uploaded, and the online games without another player.
        counts.of("results").deleted = self.execute(
            &format!(
                "DELETE FROM results WHERE (list_contains({list}, token) AND mode IS DISTINCT FROM 'online')
                   OR (mode = 'online' AND (list_contains({list}, player_x) OR list_contains({list}, player_o))
                     AND coalesce(list_contains({list}, player_x), true) AND coalesce(list_contains({list}, player_o), true))"
            ),
            by_ids,
        )?;
        // An online game that stays has another player on the other seat, who becomes its uploader.
        let mut anonymised: HashSet<String> = HashSet::new();
        let returning_ids = |db: &Db, sql: String| db.query(&sql, by_ids, |row| row.get::<_, String>(0));
        anonymised.extend(returning_ids(
            self,
            format!(
                "UPDATE results SET token = CASE WHEN list_contains({list}, player_x) THEN player_o ELSE player_x END WHERE list_contains({list}, token) RETURNING id"
            ),
        )?);
        for column in ["player_x", "player_o"] {
            anonymised.extend(returning_ids(
                self,
                format!("UPDATE results SET {column} = NULL WHERE list_contains({list}, {column}) RETURNING id"),
            )?);
        }
        counts.of("results").anonymised = anonymised.len();

        for (table, column) in [
            ("player_names", "token"),
            ("blocks", "owner"),
            ("private_stats", "owner"),
            ("achievement_resets", "owner"),
            ("achievement_players", "owner"),
            ("seat_people", "token"),
            ("practice_runs", "token"),
        ] {
            counts.of(table).deleted = self.execute(&format!("DELETE FROM {table} WHERE list_contains({list}, {column})"), by_ids)?;
        }
        // A block of this player by another player stays for that player, without the name.
        counts.of("blocks").anonymised = self.execute(
            &format!("UPDATE blocks SET name = $name WHERE list_contains({person_list}, person) AND name <> $name"),
            &[("persons", &persons), ("name", &DELETED_NAME)],
        )?;
        // A code that this player invited or claimed stays with its tester, without the person id and tokens of this player.
        counts.of("tester_codes").anonymised = self.execute(
            &format!(
                "UPDATE tester_codes SET invited_by = CASE WHEN list_contains({person_list}, invited_by) THEN NULL ELSE invited_by END,
                   claimed_token = CASE WHEN list_contains({list}, claimed_token) OR list_contains({list}, claimed_owner) THEN NULL ELSE claimed_token END,
                   claimed_owner = CASE WHEN list_contains({list}, claimed_token) OR list_contains({list}, claimed_owner) THEN NULL ELSE claimed_owner END
                 WHERE list_contains({person_list}, invited_by) OR list_contains({list}, claimed_token) OR list_contains({list}, claimed_owner)"
            ),
            &[("persons", &persons), ("ids", &ids)],
        )?;
        // The copies of this player's devices, or first opened by this player. A copy of another device keeps no
        // invite by this player.
        counts.of("app_copies").deleted =
            self.execute(&format!("DELETE FROM app_copies WHERE list_contains({list}, token) OR list_contains({list}, owner)"), by_ids)?;
        // The device slots of this player's tokens: the purchase gets the place back.
        counts.of("apple_slots").deleted = self.execute(&format!("DELETE FROM apple_slots WHERE list_contains({list}, token)"), by_ids)?;
        counts.of("app_copies").anonymised = self.execute(
            &format!("UPDATE app_copies SET invited_by = NULL WHERE list_contains({person_list}, invited_by)"),
            &[("persons", &persons)],
        )?;
        counts.of("reports").anonymised = self.execute(
            &format!(
                "UPDATE reports SET reporter = NULL, reporter_person = NULL
                 WHERE list_contains({list}, reporter) OR list_contains({person_list}, reporter_person)"
            ),
            &[("ids", &ids), ("persons", &persons)],
        )?;
        counts.of("player_tokens").deleted = self.execute(
            &format!("DELETE FROM player_tokens WHERE list_contains({list}, token) OR github_id = $account"),
            &[("ids", &ids), ("account", &account)],
        )?;
        // The notice tells the devices of other players to clean their copies (deleted_since).
        self.execute(
            &format!(
                "INSERT INTO deleted_people (person, deleted_at) SELECT unnest({person_list}), make_timestamptz($now * 1000)
                 ON CONFLICT (person) DO UPDATE SET deleted_at = excluded.deleted_at"
            ),
            &[("persons", &persons), ("now", &now_ms())],
        )?;
        if let Some(account) = account {
            counts.of("users").deleted = self.execute("DELETE FROM users WHERE github_id = $account", &[("account", &account)])?;
            counts.of("logins").deleted = self.execute("DELETE FROM logins WHERE github_id = $account", &[("account", &account)])?;
        }
        Ok((counts, changed))
    }

    /// The deletion notices since `since` (epoch ms), and the server time of the answer for the next call.
    pub fn deleted_since(&self, since: i64) -> ApiResult<DeletedSince> {
        let until = now_ms();
        let people = self.query(
            "FROM deleted_people SELECT person WHERE deleted_at >= make_timestamptz($since * 1000) AND deleted_at < make_timestamptz($until * 1000) ORDER BY person",
            &[("since", &since), ("until", &until)],
            |row| row.get(0),
        )?;
        Ok(DeletedSince { people, until })
    }
}

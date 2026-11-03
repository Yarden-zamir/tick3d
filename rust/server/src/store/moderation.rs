//! Reports and moderation (server/store.ts: report, reports, hideMessage, clearNameOf, deleteDataOf).
use axum::http::StatusCode;
use serde::Serialize;
use tick3d_core::names::name_of;
use tick3d_core::session::{ChatEntry, ChatFrom};

use super::Db;
use super::accounts::{account_of, account_row};
use super::deletion::DeletedData;
use crate::error::{ApiError, ApiResult};
use crate::ids::{ACCOUNT_TOKEN_PREFIX, PERSON_ID_LENGTH, PERSON_ID_PREFIX, account_token, person_id};
use crate::protocol::{ReportPlace, ReportRequest, ReportTarget};

/// The maintainers see this many of the newest reports and actions.
const REPORTS_SHOWN: usize = 200;
const REMOVED_MESSAGE: &str = "A moderator removed this message.";

/// A stored report as a maintainer reads it. It holds person ids, never a token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReport {
    id: i64,
    code: Option<String>,
    message: Option<i64>,
    text: Option<String>,
    person: Option<String>,
    name: Option<String>,
    reason: String,
    note: Option<String>,
    reporter: Option<String>,
    reporter_login: Option<String>,
    at: i64,
}

#[derive(Serialize)]
pub struct ModerationAction {
    login: String,
    action: String,
    code: Option<String>,
    message: Option<i64>,
    person: Option<String>,
    at: i64,
}

#[derive(Serialize)]
pub struct Reports {
    reports: Vec<StoredReport>,
    actions: Vec<ModerationAction>,
}

/// The person behind a public person id: the name that the games show.
/// Limit: only the reports read it now. The stats routes also need the canonical token, the tokens and the account
/// (statsPersonOf in server/store.ts): add them when the stats are ported.
pub struct StatsPerson {
    pub name: String,
}

/// The target of a report row.
struct Target {
    message: Option<u64>,
    text: Option<String>,
    person: Option<String>,
    name: Option<String>,
}

pub enum DeleteTarget {
    Person(String),
    Login(String),
}

impl Db {
    /// The display name of a token: the custom name, else the generated name.
    fn name_of_token(&mut self, token: &str) -> ApiResult<String> {
        Ok(self.names_of(&[token])?.remove(token).unwrap_or_else(|| name_of(token)))
    }

    /// The person behind a public person id, or None when no account and no finished game has the id.
    /// An account: DuckDB's sha256 over the accounts finds it. A device: seat_people.
    pub(super) fn stats_person_of(&mut self, person: &str) -> ApiResult<Option<StatsPerson>> {
        let accounts = self.query(
            &format!(
                "FROM (SELECT DISTINCT github_id FROM player_tokens) LEFT JOIN users USING (github_id) SELECT github_id, provider, login, avatar, name, seed
                 WHERE left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), {PERSON_ID_LENGTH}) = $person"
            ),
            &[("prefix", &PERSON_ID_PREFIX), ("account", &ACCOUNT_TOKEN_PREFIX), ("person", &person)],
            |row| Ok((row.get::<_, i64>(0)?, account_row(row, 1)?)),
        )?;
        if let Some((id, row)) = accounts.into_iter().next() {
            let name = match account_of(row)? {
                Some(player) => player.name.unwrap_or(player.login),
                None => self.name_of_token(&account_token(id))?,
            };
            return Ok(Some(StatsPerson { name }));
        }
        // A device without an account. A linked token stands for its account, so it is not a device person.
        let devices: Vec<String> = self.query(
            "FROM seat_people p SELECT p.token
             WHERE p.person = $person AND p.token NOT IN (FROM player_tokens SELECT token)
               AND (EXISTS (FROM results WHERE player_x = p.token) OR EXISTS (FROM results WHERE player_o = p.token))",
            &[("person", &person)],
            |row| row.get(0),
        )?;
        let Some(token) = devices.into_iter().next() else { return Ok(None) };
        Ok(Some(StatsPerson { name: self.name_of_token(&token)? }))
    }

    /// Stores a report of a message or a person of an online session. The session must hold the target now.
    /// A report without a code names a person of the stats page: any person with a finished game or an account.
    pub fn report(&mut self, token: &str, request: ReportRequest) -> ApiResult<i64> {
        let reporter = self.owner_of(token)?;
        let (code, target) = match request.place {
            ReportPlace::StatsPage { person } => {
                let found = self
                    .stats_person_of(&person)?
                    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "That player has no finished games."))?;
                (None, Target { message: None, text: None, person: Some(person), name: Some(found.name) })
            }
            ReportPlace::Session { code, target } => {
                let row = self.load(&code)?;
                let watchers = self.audience(&row.code, &row.doc)?.watchers;
                let everyone: Vec<String> = [row.doc.seats.x.clone(), row.doc.seats.o.clone()]
                    .into_iter()
                    .flatten()
                    .chain(watchers.into_iter().map(|watcher| watcher.token))
                    .collect();
                let refs: Vec<&str> = everyone.iter().map(String::as_str).collect();
                let persons = self.persons_of(&refs)?;
                let person = |token: &str| persons.get(token).cloned();
                let target = match target {
                    ReportTarget::Message(id) => {
                        let found = row.doc.chat.iter().find_map(|entry| match entry {
                            ChatEntry::Message { id: message, from, text, by, .. } if *message == id => Some((from, text, by)),
                            _ => None,
                        });
                        // An event has no writer and no text, so nobody can report it.
                        let (from, text, by) =
                            found.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "That message is not in the chat any more."))?;
                        // The writer by person id. An older message without one stands for the holder of its seat.
                        let author = match (by, from) {
                            (Some(by), _) => everyone.iter().find(|candidate| person(candidate).as_ref() == Some(by)).cloned(),
                            (None, ChatFrom::Watcher) => None,
                            (None, ChatFrom::X) => row.doc.seats.x.clone(),
                            (None, ChatFrom::O) => row.doc.seats.o.clone(),
                        };
                        let name = author.as_deref().map(|author| self.name_of_token(author)).transpose()?;
                        let person = by.clone().or_else(|| author.as_deref().and_then(person));
                        Target { message: Some(id), text: Some(text.clone()), person, name }
                    }
                    ReportTarget::Person(id) => {
                        let found = everyone
                            .iter()
                            .find(|candidate| person(candidate).as_deref() == Some(id.as_str()))
                            .cloned()
                            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "That person is not in this game now."))?;
                        Target { message: None, text: None, person: Some(id), name: Some(self.name_of_token(&found)?) }
                    }
                };
                (Some(row.code), target)
            }
        };
        let message = target.message.map(|id| i64::try_from(id).expect("a message id is a safe integer"));
        // A write through `query` for its RETURNING: `reports` is not an account table, so the token sets stay.
        let stored: Vec<i64> = self.query(
            "INSERT INTO reports (code, message, message_text, person, person_name, reason, note, reporter, reporter_person)
             VALUES ($code, $message, $text, $person, $name, $reason, $note, $reporter, $reporterPerson) RETURNING id",
            &[
                ("code", &code),
                ("message", &message),
                ("text", &target.text),
                ("person", &target.person),
                ("name", &target.name),
                ("reason", &request.reason),
                ("note", &request.note),
                ("reporter", &reporter),
                ("reporterPerson", &person_id(&reporter)),
            ],
            |row| row.get(0),
        )?;
        stored.into_iter().next().ok_or_else(|| ApiError::fault("a report insert returned no id"))
    }

    /// The newest reports and moderation actions, for the maintainers.
    pub fn reports(&self) -> ApiResult<Reports> {
        let reports = self.query(
            &format!(
                "FROM reports r LEFT JOIN player_tokens t ON t.token = r.reporter LEFT JOIN users u ON u.github_id = t.github_id
                 SELECT r.id, r.code, r.message, r.message_text, r.person, r.person_name, r.reason, r.note, r.reporter_person, u.login, epoch_ms(r.created_at)
                 ORDER BY r.id DESC LIMIT {REPORTS_SHOWN}"
            ),
            &[],
            |row| {
                Ok(StoredReport {
                    id: row.get(0)?,
                    code: row.get(1)?,
                    message: row.get(2)?,
                    text: row.get(3)?,
                    person: row.get(4)?,
                    name: row.get(5)?,
                    reason: row.get(6)?,
                    note: row.get(7)?,
                    reporter: row.get(8)?,
                    reporter_login: row.get(9)?,
                    at: row.get(10)?,
                })
            },
        )?;
        let actions = self.query(
            &format!(
                "FROM moderation_log SELECT login, action, code, message, person, epoch_ms(created_at) ORDER BY created_at DESC LIMIT {REPORTS_SHOWN}"
            ),
            &[],
            |row| {
                Ok(ModerationAction {
                    login: row.get(0)?,
                    action: row.get(1)?,
                    code: row.get(2)?,
                    message: row.get(3)?,
                    person: row.get(4)?,
                    at: row.get(5)?,
                })
            },
        )?;
        Ok(Reports { reports, actions })
    }

    fn log_moderation(
        &mut self,
        login: &str,
        action: &str,
        code: Option<&str>,
        message: Option<i64>,
        person: Option<&str>,
    ) -> ApiResult<()> {
        self.execute(
            "INSERT INTO moderation_log (login, action, code, message, person) VALUES ($login, $action, $code, $message, $person)",
            &[("login", &login), ("action", &action), ("code", &code), ("message", &message), ("person", &person)],
        )?;
        Ok(())
    }

    /// A maintainer hides a chat message for everyone: its text becomes REMOVED_MESSAGE. The message keeps its id, so
    /// the next message never takes the id of a message that a page hid on report.
    pub fn hide_message(&mut self, code: &str, message: i64, login: &str) -> ApiResult<()> {
        let row = self.load(code)?;
        let mut doc = row.doc.clone();
        let entry = doc.chat.iter_mut().find_map(|entry| match entry {
            ChatEntry::Message { id, text, .. } if i64::try_from(*id).ok() == Some(message) => Some(text),
            _ => None,
        });
        let text = entry.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "That message is not in the chat."))?;
        *text = REMOVED_MESSAGE.to_owned();
        self.save(&row, doc)?;
        self.log_moderation(login, "hide-message", Some(code), Some(message), None)
    }

    /// A maintainer clears the custom name of a person: of a device, or of an account. Returns the tokens that lost a
    /// name, so the HTTP layer tells their open sessions. DuckDB's sha256 finds the token behind the person id.
    pub fn clear_name_of(&mut self, person: &str, login: &str) -> ApiResult<Vec<String>> {
        let mut cleared: Vec<String> = self.query(
            &format!("DELETE FROM player_names WHERE left(sha256($prefix || token), {PERSON_ID_LENGTH}) = $person RETURNING token"),
            &[("prefix", &PERSON_ID_PREFIX), ("person", &person)],
            |row| row.get(0),
        )?;
        let accounts: Vec<i64> = self.query(
            &format!(
                "UPDATE users SET name = NULL
                 WHERE name IS NOT NULL AND left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), {PERSON_ID_LENGTH}) = $person
                 RETURNING github_id"
            ),
            &[("prefix", &PERSON_ID_PREFIX), ("account", &ACCOUNT_TOKEN_PREFIX), ("person", &person)],
            |row| row.get(0),
        )?;
        // The DELETE above went through `query` for its RETURNING: mark the token sets old, as `execute` does.
        self.tokens.after_write("player_names");
        for id in accounts {
            cleared.extend(
                self.query("FROM player_tokens SELECT token WHERE github_id = $id", &[("id", &id)], |row| row.get::<_, String>(0))?,
            );
        }
        if cleared.is_empty() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "That person has no custom name."));
        }
        self.log_moderation(login, "clear-name", None, None, Some(person))?;
        Ok(cleared)
    }

    /// The same deletion as Delete my data, for an email request by a maintainer: by public person id, or by GitHub
    /// login. 404 when nobody has that id or login.
    /// Limit: the person search scans the columns that hold tokens. Revisit when one call takes more than about a second.
    pub fn delete_data_of(&mut self, target: DeleteTarget) -> ApiResult<DeletedData> {
        let token = match target {
            DeleteTarget::Login(login) => {
                let found: Vec<i64> = self.query(
                    "FROM logins SELECT github_id WHERE provider = 'github' AND lower(label) = lower($login)",
                    &[("login", &login)],
                    |row| row.get(0),
                )?;
                found.into_iter().next().map(|id| self.ensure_account_row(id)).transpose()?
            }
            DeleteTarget::Person(person) => {
                let found: Vec<String> = self.query(
                    &format!(
                        "WITH tokens AS (
                           FROM player_tokens SELECT token UNION FROM player_names SELECT token UNION FROM practice_runs SELECT token
                           UNION FROM blocks SELECT owner UNION FROM results SELECT token UNION FROM results SELECT player_x UNION FROM results SELECT player_o
                           UNION FROM sessions SELECT doc.seats.X::VARCHAR UNION FROM sessions SELECT doc.seats.O::VARCHAR)
                         FROM tokens SELECT token WHERE token IS NOT NULL AND left(sha256($prefix || token), {PERSON_ID_LENGTH}) = $person LIMIT 1"
                    ),
                    &[("prefix", &PERSON_ID_PREFIX), ("person", &person)],
                    |row| row.get(0),
                )?;
                // A seat that only memory has: a player who joined a running game and has no other row yet.
                found.into_iter().next().or_else(|| self.seat_in_memory(|seat| person_id(seat) == person))
            }
        };
        let token = token.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Nobody has that person id or GitHub login."))?;
        // An account token is not a valid X-Player value, but identity_of reads it like a device token of the account.
        self.delete_for(&token)
    }
}

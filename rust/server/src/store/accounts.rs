//! The accounts, devices and names behind player tokens (server/store.ts: identityOf, accountsOf, namesOf, audience).
use std::collections::{HashMap, HashSet};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tick3d_core::game::{PerPlayer, Player};
use tick3d_core::names::name_of;
use tick3d_core::session::{COMPUTER_TOKEN, Identity, LoginProvider, OpenWatcher, PlayerInfo, SessionDoc};

use super::{Db, json_list};
use crate::error::{ApiError, ApiResult};
use crate::ids::{ACCOUNT_TOKEN_PREFIX, account_token, person_id};

const WATCHER_ID_LENGTH: usize = 16;

/// The tokens with a row in player_tokens (a login) and in player_names (a custom name), read on demand.
/// Most players have neither, and their lookups need no SQL. A write on either table marks the sets old.
/// Limit: one string per linked device and per custom name, read again after each such write. Revisit if logins
/// and renames reach about one per second.
#[derive(Default)]
pub struct TokenSets {
    linked: Option<HashSet<String>>,
    named: Option<HashSet<String>>,
}

impl TokenSets {
    pub fn after_write(&mut self, sql: &str) {
        let rollback = sql.trim_start().to_uppercase().starts_with("ROLLBACK");
        if rollback || sql.contains("player_tokens") || sql.contains("player_names") {
            self.linked = None;
            self.named = None;
        }
    }
}

/// Who has a session open: the present seats, the watchers, and the name and person id of each token.
pub struct AudienceData {
    pub presence: PerPlayer<bool>,
    pub watchers: Vec<OpenWatcher>,
    names: HashMap<String, String>,
    persons: HashMap<String, String>,
}

impl AudienceData {
    pub fn name(&self, token: &str) -> String {
        self.names.get(token).cloned().unwrap_or_else(|| name_of(token))
    }

    pub fn person(&self, token: &str) -> Option<String> {
        self.persons.get(token).cloned()
    }
}

/// The columns of users that make a PlayerInfo: provider, login, avatar, name, seed. All nullable for a LEFT JOIN.
pub(super) type AccountRow = (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

pub(super) fn account_row(row: &duckdb::Row, first: usize) -> duckdb::Result<AccountRow> {
    Ok((row.get(first)?, row.get(first + 1)?, row.get(first + 2)?, row.get(first + 3)?, row.get(first + 4)?))
}

/// The account of a seat from a LEFT JOIN of users: no login means no account.
/// A Google name is often a real name, so after a rename the custom name takes its place: nobody else sees it.
pub(super) fn account_of((provider, login, avatar, name, seed): AccountRow) -> ApiResult<Option<PlayerInfo>> {
    let Some(login) = login else { return Ok(None) };
    let provider = match provider.as_deref() {
        Some("github") => LoginProvider::Github,
        Some("google") => LoginProvider::Google,
        other => return Err(ApiError::fault(format!("a stored account has the provider {other:?}"))),
    };
    if provider == LoginProvider::Github && avatar.is_none() {
        return Err(ApiError::fault("a stored GitHub account has no avatar"));
    }
    let login = match (&provider, &name) {
        (LoginProvider::Google, Some(name)) => name.clone(),
        _ => login,
    };
    Ok(Some(PlayerInfo { provider, login, avatar, name, seed }))
}

impl Db {
    fn linked_tokens(&mut self) -> ApiResult<&HashSet<String>> {
        if self.tokens.linked.is_none() {
            let tokens = self.query("FROM player_tokens SELECT token", &[], |row| row.get(0))?;
            self.tokens.linked = Some(tokens.into_iter().collect());
        }
        Ok(self.tokens.linked.as_ref().expect("the linked tokens are loaded"))
    }

    fn named_tokens(&mut self) -> ApiResult<&HashSet<String>> {
        if self.tokens.named.is_none() {
            let tokens = self.query("FROM player_names SELECT token", &[], |row| row.get(0))?;
            self.tokens.named = Some(tokens.into_iter().collect());
        }
        Ok(self.tokens.named.as_ref().expect("the named tokens are loaded"))
    }

    fn account_id_of(&mut self, token: &str) -> ApiResult<Option<i64>> {
        if !self.linked_tokens()?.contains(token) {
            return Ok(None);
        }
        let found = self.query("FROM player_tokens SELECT github_id WHERE token = $token", &[("token", &token)], |row| row.get(0))?;
        Ok(found.into_iter().next())
    }

    /// The account token has a player_tokens row before any seat names it.
    pub fn ensure_account_row(&mut self, account_id: i64) -> ApiResult<String> {
        let account = account_token(account_id);
        // A lookup first: the insert is a write, and each write drops the token sets.
        if !self.linked_tokens()?.contains(&account) {
            self.execute(
                "INSERT INTO player_tokens (token, github_id) VALUES ($token, $id) ON CONFLICT (token) DO NOTHING",
                &[("token", &account), ("id", &account_id)],
            )?;
        }
        Ok(account)
    }

    /// The token that a new seat of this device holds: the account token when the device is logged in.
    pub fn seat_token_of(&mut self, token: &str) -> ApiResult<String> {
        match self.account_id_of(token)? {
            None => Ok(token.to_owned()),
            Some(id) => self.ensure_account_row(id),
        }
    }

    /// The token plus the tokens of the same account (the account token among them), so a logged-in player holds
    /// their seats on every device.
    pub fn identity_of(&mut self, token: Option<&str>) -> ApiResult<Identity> {
        let Some(token) = token else { return Ok(Identity::new()) };
        let Some(id) = self.account_id_of(token)? else { return Ok(Identity::from([token.to_owned()])) };
        let linked: Vec<String> = self.query("FROM player_tokens SELECT token WHERE github_id = $id", &[("id", &id)], |row| row.get(0))?;
        // The account token counts also before its own row exists.
        let mut identity = Identity::from([token.to_owned(), account_token(id)]);
        identity.extend(linked);
        Ok(identity)
    }

    /// The account of each token. A token without an account has none.
    pub fn accounts_of(&mut self, tokens: &[&str]) -> ApiResult<HashMap<String, PlayerInfo>> {
        let linked = self.linked_tokens()?;
        let known: Vec<String> = tokens
            .iter()
            .filter(|token| linked.contains(**token))
            .map(|token| (*token).to_owned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if known.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = self.query(
            "FROM player_tokens JOIN users USING (github_id) SELECT token, provider, login, avatar, name, seed
             WHERE list_contains(CAST($tokens AS JSON)::VARCHAR[], token)",
            &[("tokens", &json_list(&known))],
            |row| Ok((row.get::<_, String>(0)?, account_row(row, 1)?)),
        )?;
        let mut found = HashMap::new();
        for (token, account) in rows {
            if let Some(info) = account_of(account)? {
                found.insert(token, info);
            }
        }
        Ok(found)
    }

    pub fn players_of(&mut self, doc: &SessionDoc) -> ApiResult<PerPlayer<Option<PlayerInfo>>> {
        let seats: Vec<&str> = [&doc.seats.x, &doc.seats.o].into_iter().flatten().map(String::as_str).collect();
        let accounts = self.accounts_of(&seats)?;
        let info = |seat: &Option<String>| seat.as_ref().and_then(|token| accounts.get(token).cloned());
        Ok(PerPlayer { x: info(&doc.seats.x), o: info(&doc.seats.o) })
    }

    /// The token that stands for a person: the account token of a linked device, else the token itself.
    pub fn canonical(&mut self, tokens: &[&str]) -> ApiResult<HashMap<String, String>> {
        let linked = self.linked_tokens()?;
        let asked: Vec<String> = tokens.iter().filter(|token| linked.contains(**token)).map(|token| (*token).to_owned()).collect();
        let accounts: HashMap<String, String> = if asked.is_empty() {
            HashMap::new()
        } else {
            self.query(
                "FROM player_tokens SELECT token, github_id WHERE list_contains(CAST($tokens AS JSON)::VARCHAR[], token)",
                &[("tokens", &json_list(&asked))],
                |row| Ok((row.get::<_, String>(0)?, account_token(row.get(1)?))),
            )?
            .into_iter()
            .collect()
        };
        Ok(tokens.iter().map(|token| ((*token).to_owned(), accounts.get(*token).cloned().unwrap_or_else(|| (*token).to_owned()))).collect())
    }

    /// The canonical token of the caller.
    pub fn owner_of(&mut self, token: &str) -> ApiResult<String> {
        Ok(self.canonical(&[token])?.remove(token).expect("canonical answers for every token"))
    }

    /// The public person id of each token, through its canonical token. The computer has none.
    pub(super) fn persons_of(&mut self, tokens: &[&str]) -> ApiResult<HashMap<String, String>> {
        let humans: Vec<&str> = tokens.iter().copied().filter(|token| *token != COMPUTER_TOKEN).collect();
        Ok(self.canonical(&humans)?.into_iter().map(|(token, owner)| (token, person_id(&owner))).collect())
    }

    /// The custom name of each token that has one (player_names).
    pub(super) fn names_of(&mut self, tokens: &[&str]) -> ApiResult<HashMap<String, String>> {
        let named = self.named_tokens()?;
        let known: Vec<String> = tokens.iter().filter(|token| named.contains(**token)).map(|token| (*token).to_owned()).collect();
        if known.is_empty() {
            return Ok(HashMap::new());
        }
        Ok(self
            .query(
                "FROM player_names SELECT token, name WHERE list_contains(CAST($tokens AS JSON)::VARCHAR[], token)",
                &[("tokens", &json_list(&known))],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .into_iter()
            .collect())
    }

    /// Watcher ids hide the token behind a keyed hash. The key lives in this process only, so the ids change on a
    /// restart. That is fine: pages read the list again with every change.
    fn watcher_id(&self, code: &str, token: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.watcher_key).expect("HMAC takes any key length");
        mac.update(format!("{code}:{token}").as_bytes());
        let hex: String = mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
        hex[..WATCHER_ID_LENGTH].to_owned()
    }

    /// Who has the session open. A token whose account holds a seat on another device counts for that seat.
    /// Two devices of one account watch as one watcher.
    pub fn audience(&mut self, code: &str, doc: &SessionDoc) -> ApiResult<AudienceData> {
        let mut tokens = self.hooks.open_tokens(code);
        let mut seen = HashSet::new();
        tokens.retain(|token| seen.insert(token.clone()));
        let linked_set = self.linked_tokens()?;
        let with_login: Vec<String> = tokens.iter().filter(|token| linked_set.contains(*token)).cloned().collect();
        type Linked = (String, String, i64, AccountRow);
        let linked: Vec<Linked> = if with_login.is_empty() {
            Vec::new()
        } else {
            self.query(
                "FROM player_tokens a JOIN player_tokens b USING (github_id) JOIN users u USING (github_id)
                 SELECT a.token AS token, b.token AS linked, u.github_id, u.provider, u.login, u.avatar, u.name, u.seed
                 WHERE list_contains(CAST($tokens AS JSON)::VARCHAR[], a.token)",
                &[("tokens", &json_list(&with_login))],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, account_row(row, 3)?)),
            )?
        };
        let mut presence = PerPlayer { x: false, o: false };
        let mut watchers = Vec::new();
        // One watcher per account: two Google players can have the same name, so the account id tells them apart.
        let mut accounts = HashSet::new();
        for token in &tokens {
            let own: Vec<&Linked> = linked.iter().filter(|row| row.0 == *token).collect();
            let mut identity = Identity::from([token.clone()]);
            identity.extend(own.iter().map(|row| row.1.clone()));
            let seats = doc.seats_of(&identity);
            for seat in &seats {
                match seat {
                    Player::X => presence.x = true,
                    Player::O => presence.o = true,
                }
            }
            if !seats.is_empty() {
                continue;
            }
            let account = own.first();
            if let Some(account) = account
                && !accounts.insert(account.2)
            {
                continue;
            }
            let player = match account {
                None => None,
                Some(account) => account_of(account.3.clone())?,
            };
            // A logged-in watcher takes a seat for the account, like a join. The id stays from the device token.
            let watcher_token = account.map_or_else(|| token.clone(), |account| account_token(account.2));
            watchers.push(OpenWatcher { id: self.watcher_id(code, token), token: watcher_token, player });
        }
        let mut everyone: Vec<&str> = [&doc.seats.x, &doc.seats.o].into_iter().flatten().map(String::as_str).collect();
        if let Some(request) = &doc.seat_request
            && let Some(watcher) = &request.watcher
        {
            everyone.push(watcher);
        }
        everyone.extend(watchers.iter().map(|watcher| watcher.token.as_str()));
        let names = self.names_of(&everyone)?;
        let persons = self.persons_of(&everyone)?;
        Ok(AudienceData { presence, watchers, names, persons })
    }

    /// The account id in an account token (accountIdOf in server/store.ts).
    pub fn account_id_in(token: &str) -> i64 {
        let digits = token.strip_prefix(ACCOUNT_TOKEN_PREFIX).expect("an account token has the prefix");
        let digits = digits.trim_start_matches('0');
        if digits.is_empty() { 0 } else { digits.parse().expect("an account token holds an account id") }
    }
}

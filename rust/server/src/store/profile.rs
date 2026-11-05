//! The logins, names, pictures and settings of a player.
use axum::http::StatusCode;
use rand::RngExt;
use serde::Serialize;
use tick3d_core::names::name_of;
use tick3d_core::session::{COMPUTER_TOKEN, PlayerInfo};

use super::accounts::{account_of, account_row};
use super::{Db, Params};
use crate::auth::Login;
use crate::error::{ApiError, ApiResult};
use crate::ids::{account_token, person_id};
use crate::protocol::AvatarPicture;

/// The name and photo of a Google sign-in. A Google cookie has none: the sign-in stores them.
pub struct GoogleProfile {
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// A person that the caller blocked. `name` is the name that the caller saw at the block.
#[derive(Serialize)]
pub struct BlockedPerson {
    pub person: String,
    pub name: String,
    pub at: i64,
}

/// At most this many blocks per player.
const BLOCKS_KEPT: i64 = 500;
const AVATAR_SEED_LENGTH: usize = 12;

/// The key of a login in `logins`: provider, subject, and the GitHub login as its label.
fn login_key(login: &Login) -> (&'static str, String, Option<&str>) {
    match login {
        Login::GitHub { id, login, .. } => ("github", id.to_string(), Some(login.as_str())),
        Login::Google { google } => ("google", google.clone(), None),
    }
}

/// The shown name of a login provider.
fn provider_label(provider: &str) -> &'static str {
    match provider {
        "github" => "GitHub",
        "google" => "Google",
        other => panic!("unknown login provider {other}"),
    }
}

fn provider_name(picture: AvatarPicture) -> &'static str {
    match picture {
        AvatarPicture::Github => "GitHub",
        AvatarPicture::Google => "Google",
        AvatarPicture::Generated => "row",
    }
}

impl Db {
    /// True when `name` is the GitHub login of an account other than `account` (GitHub logins ignore case).
    fn is_github_login_of_other(&self, name: &str, account: Option<i64>) -> ApiResult<bool> {
        let clash: Vec<String> = self.query(
            "FROM logins SELECT label WHERE provider = 'github' AND lower(label) = lower($name) AND github_id IS DISTINCT FROM $account",
            &[("name", &name), ("account", &account)],
            |row| row.get(0),
        )?;
        Ok(!clash.is_empty())
    }

    /// The account of a login, or None when the login has none yet.
    fn known_account_of(&self, login: &Login) -> ApiResult<Option<i64>> {
        let (provider, subject, _) = login_key(login);
        let found = self.query(
            "FROM logins SELECT github_id WHERE provider = $provider AND subject = $subject",
            &[("provider", &provider), ("subject", &subject)],
            |row| row.get(0),
        )?;
        Ok(found.into_iter().next())
    }

    /// The account of a login. A login without an account makes one: a GitHub login with its GitHub id, a Google
    /// login with a new negative id. The login that made the account gives it its name and picture, and refreshes
    /// them: a GitHub login on every request, a Google login at each sign-in (`profile`).
    pub fn account_of_login(&mut self, login: &Login, profile: Option<&GoogleProfile>) -> ApiResult<i64> {
        let (provider, subject, label) = login_key(login);
        let id = match self.known_account_of(login)? {
            Some(id) => {
                if let Some(label) = label {
                    self.execute(
                        "UPDATE logins SET label = $label WHERE provider = $provider AND subject = $subject",
                        &[("label", &label), ("provider", &provider), ("subject", &subject)],
                    )?;
                }
                id
            }
            None => {
                let id = match login {
                    Login::GitHub { id, .. } => *id,
                    Login::Google { .. } => {
                        let next: Vec<i64> = self.query("SELECT -nextval('account_ids') AS id", &[], |row| row.get(0))?;
                        next.into_iter().next().ok_or_else(|| ApiError::fault("the account id sequence answered nothing"))?
                    }
                };
                self.execute(
                    "INSERT INTO logins (provider, subject, github_id, label) VALUES ($provider, $subject, $id, $label)",
                    &[("provider", &provider), ("subject", &subject), ("id", &id), ("label", &label)],
                )?;
                id
            }
        };
        // A Google cookie has no profile: its account keeps the name and photo of the last sign-in. A Google name
        // that is the GitHub login of another account would pose as that player: it gets a generated name.
        let generated = name_of(&account_token(id));
        let shown: Option<(String, Option<String>)> = match (login, profile) {
            (_, Some(profile)) => {
                let name = match &profile.name {
                    Some(name) if !self.is_github_login_of_other(name, Some(id))? => name.clone(),
                    _ => generated.clone(),
                };
                Some((name, profile.picture.clone()))
            }
            (Login::Google { .. }, None) => None,
            (Login::GitHub { login, avatar, .. }, None) => Some((login.clone(), Some(avatar.clone()))),
        };
        let (first_login, first_avatar) = shown.clone().unwrap_or((generated, None));
        self.execute(
            "INSERT INTO users (github_id, provider, login, avatar) VALUES ($id, $provider, $login, $avatar) ON CONFLICT DO NOTHING",
            &[("id", &id), ("provider", &provider), ("login", &first_login), ("avatar", &first_avatar)],
        )?;
        if let Some((login, avatar)) = shown {
            self.execute(
                "UPDATE users SET login = $login, avatar = $avatar WHERE github_id = $id AND provider = $provider",
                &[("id", &id), ("provider", &provider), ("login", &login), ("avatar", &avatar)],
            )?;
        }
        self.execute("UPDATE users SET seen_at = now() WHERE github_id = $id", &[("id", &id)])?;
        Ok(id)
    }

    /// Links this browser to the account of a login, and returns the account id.
    /// Every logged-in visit calls it, so a device that already holds this account changes nothing: no write, which would
    /// drop the token sets, and no achievement refresh.
    pub fn link_token(&mut self, token: &str, login: &Login, profile: Option<&GoogleProfile>) -> ApiResult<i64> {
        let id = self.account_of_login(login, profile)?;
        let linked: Option<i64> = self
            .query("FROM player_tokens SELECT github_id WHERE token = $token", &[("token", &token)], |row| row.get(0))?
            .into_iter()
            .next();
        if linked == Some(id) {
            return Ok(id);
        }
        // The games of the device move to the account, also from an account that the device was linked to before.
        let mut changed = vec![self.owner_of(token)?, token.to_owned(), account_token(id)];
        // The players who met this device now meet the account, so the opponent of their games changes.
        // An achievement about different people can lock again: two devices of one person count once.
        let device = [token.to_owned()];
        let names = super::games::token_names(&device);
        let met = self.query(
            &format!("FROM {} results SELECT results.player_x, results.player_o", super::games::seated_results(1)),
            &super::games::token_params(&names, &device),
            |row| Ok([row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?]),
        )?;
        let others: Vec<String> = met.into_iter().flatten().flatten().filter(|seat| seat != token && seat != COMPUTER_TOKEN).collect();
        let others: Vec<&str> = others.iter().map(String::as_str).collect();
        changed.extend(self.canonical(&others)?.into_values());
        self.games_changed(changed);
        self.execute(
            "INSERT INTO player_tokens (token, github_id) VALUES ($token, $id)
             ON CONFLICT (token) DO UPDATE SET github_id = excluded.github_id, linked_at = now()",
            &[("token", &token), ("id", &id)],
        )?;
        self.ensure_account_row(id)?;
        Ok(id)
    }

    /// Adds a login of the other provider to the account of `current`, so both logins open the same account.
    /// A login that already has its own account brings it along: merge_accounts moves it into this one.
    pub fn connect_login(&mut self, current: &Login, adding: &Login) -> ApiResult<()> {
        let (provider, subject, label) = login_key(adding);
        assert_ne!(provider, login_key(current).0, "a login connects only a login of the other provider");
        let account = self.account_of_login(current, None)?;
        let found = self.known_account_of(adding)?;
        if found == Some(account) {
            return Ok(());
        }
        let other: Vec<String> = self.query(
            "FROM logins SELECT subject WHERE provider = $provider AND github_id = $account",
            &[("provider", &provider), ("account", &account)],
            |row| row.get(0),
        )?;
        if !other.is_empty() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!("This account already has another {} login.", provider_label(provider)),
            ));
        }
        match found {
            Some(found) => self.merge_accounts(account, found),
            None => {
                self.execute(
                    "INSERT INTO logins (provider, subject, github_id, label) VALUES ($provider, $subject, $account, $label)",
                    &[("provider", &provider), ("subject", &subject), ("account", &account), ("label", &label)],
                )?;
                Ok(())
            }
        }
    }

    /// Moves the account `from` into the account `into`, in one transaction. `into` keeps its name, picture and custom
    /// name. The devices of `from` and its account token point to `into`, so its seats, games and stats follow. The
    /// rows that name the account token of `from` as their owner move. A report keeps the person id of its time.
    /// Limit: a chat message from before the merge names the old person id, so it shows again to a player who blocked
    /// `from`. Revisit this when a player reports such a message.
    fn merge_accounts(&mut self, into: i64, from: i64) -> ApiResult<()> {
        let conflict: Vec<String> = self.query(
            "FROM logins a JOIN logins b USING (provider) SELECT provider WHERE a.github_id = $into AND b.github_id = $from",
            &[("into", &into), ("from", &from)],
            |row| row.get(0),
        )?;
        if let Some(provider) = conflict.first() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!("Both accounts have a {} login, so they cannot become one.", provider_label(provider)),
            ));
        }
        let (into_token, from_token) = (account_token(into), account_token(from));
        let (into_person, from_person) = (person_id(&into_token), person_id(&from_token));
        let ids: Params = &[("into", &into), ("from", &from)];
        let owners: Params = &[("into", &into_token), ("from", &from_token)];
        let source: Params = &[("from", &from_token)];
        let persons: Params = &[("into", &into_person), ("from", &from_person)];
        let statements: [(&str, Params); 14] = [
            ("UPDATE logins SET github_id = $into WHERE github_id = $from", ids),
            ("UPDATE player_tokens SET github_id = $into WHERE github_id = $from", ids),
            ("DELETE FROM users WHERE github_id = $from", &ids[1..]),
            // A block of either account stays, once.
            ("INSERT INTO blocks SELECT * REPLACE ($into AS owner) FROM blocks WHERE owner = $from ON CONFLICT DO NOTHING", owners),
            ("DELETE FROM blocks WHERE owner = $from", source),
            // Hidden stats stay hidden when either account hid them.
            (
                "INSERT INTO private_stats SELECT * REPLACE ($into AS owner) FROM private_stats WHERE owner = $from ON CONFLICT DO NOTHING",
                owners,
            ),
            ("DELETE FROM private_stats WHERE owner = $from", source),
            // The later reset wins, so no game counts that a reset of either account dropped.
            (
                "INSERT INTO achievement_resets SELECT * REPLACE ($into AS owner) FROM achievement_resets WHERE owner = $from
                 ON CONFLICT (owner) DO UPDATE SET reset_at = greatest(achievement_resets.reset_at, excluded.reset_at)",
                owners,
            ),
            ("DELETE FROM achievement_resets WHERE owner = $from", source),
            ("DELETE FROM achievement_players WHERE owner = $from", source),
            ("UPDATE app_copies SET owner = $into WHERE owner = $from", owners),
            ("UPDATE tester_codes SET claimed_owner = $into WHERE claimed_owner = $from", owners),
            ("INSERT INTO blocks SELECT * REPLACE ($into AS person) FROM blocks WHERE person = $from ON CONFLICT DO NOTHING", persons),
            ("DELETE FROM blocks WHERE person = $from", &persons[1..]),
        ];
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = statements.iter().try_for_each(|(sql, params)| self.execute(sql, params).map(|_| ()));
        match result {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                self.games_changed([into_token, from_token]);
                Ok(())
            }
            Err(error) => {
                self.conn.execute_batch("ROLLBACK")?;
                self.tokens.after_write("ROLLBACK");
                Err(error.into())
            }
        }
    }

    /// Logout: this browser no longer acts for its account. The other devices of the account stay linked. A seat that
    /// holds this device token goes to the account first, and so does every result that names this device token.
    /// The browser then lists and counts none of them. hidden_x and hidden_o stay: a cleared seat stays cleared.
    /// Limit: the result updates scan the results table. Revisit at about 100,000 results, or when a logout takes more
    /// than about 100 ms.
    pub fn unlink_token(&mut self, token: &str) -> ApiResult<()> {
        let linked: Vec<i64> =
            self.query("FROM player_tokens SELECT github_id WHERE token = $token", &[("token", &token)], |row| row.get(0))?;
        let Some(id) = linked.into_iter().next() else { return Ok(()) };
        let account = self.ensure_account_row(id)?;
        let saved: Vec<String> = self.query(
            "FROM sessions SELECT code WHERE seat_x = $token
             UNION ALL FROM sessions SELECT code WHERE seat_o = $token AND (seat_x IS NULL OR seat_x <> $token)",
            &[("token", &token)],
            |row| row.get(0),
        )?;
        let mine = |seat: &Option<String>| seat.as_deref() == Some(token);
        for row in self.sessions_where(saved, |doc| mine(&doc.seats.x) || mine(&doc.seats.o))? {
            let mut doc = row.doc.clone();
            for seat in [&mut doc.seats.x, &mut doc.seats.o] {
                if mine(seat) {
                    *seat = Some(account.clone());
                }
            }
            self.save(&row, doc)?;
        }
        for column in ["token", "player_x", "player_o"] {
            self.execute(
                &format!("UPDATE results SET {column} = $account WHERE {column} = $token"),
                &[("account", &account), ("token", &token)],
            )?;
        }
        self.execute("DELETE FROM player_tokens WHERE token = $token", &[("token", &token)])?;
        Ok(())
    }

    /// The logins of the account of this device: the GitHub login, and whether it has Google.
    pub fn logins_of(&self, token: &str) -> ApiResult<(Option<String>, bool)> {
        let found: Vec<(String, Option<String>)> = self.query(
            "FROM player_tokens JOIN logins USING (github_id) SELECT provider, label WHERE token = $token",
            &[("token", &token)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let github = found.iter().find(|(provider, _)| provider == "github").and_then(|(_, label)| label.clone());
        Ok((github, found.iter().any(|(provider, _)| provider == "google")))
    }

    /// The account of a linked device, with its name and picture choices.
    pub fn account(&self, token: &str) -> ApiResult<Option<PlayerInfo>> {
        let found = self.query(
            "FROM player_tokens JOIN users USING (github_id) SELECT provider, login, avatar, name, seed WHERE token = $token",
            &[("token", &token)],
            |row| account_row(row, 0),
        )?;
        match found.into_iter().next() {
            None => Ok(None),
            Some(row) => account_of(row),
        }
    }

    pub fn custom_name(&self, token: &str) -> ApiResult<Option<String>> {
        let found = self.query("FROM player_names SELECT name WHERE token = $token", &[("token", &token)], |row| row.get(0))?;
        Ok(found.into_iter().next())
    }

    /// True when this device, or another device of its account, opened the app.
    pub fn has_copy(&self, token: &str) -> ApiResult<bool> {
        let found: Vec<String> = self.query(
            "FROM app_copies SELECT token
             WHERE token = $token OR token IN (FROM player_tokens SELECT token WHERE github_id = (FROM player_tokens SELECT github_id WHERE token = $token))
             LIMIT 1",
            &[("token", &token)],
            |row| row.get(0),
        )?;
        Ok(!found.is_empty())
    }

    /// The public person id of this player: of the account when the device is linked.
    pub fn person(&mut self, token: &str) -> ApiResult<String> {
        Ok(person_id(&self.owner_of(token)?))
    }

    /// The name of a device, or of the account when `account` is the account of the caller's login. Refuses a name
    /// that equals the login of another GitHub account, so nobody can pose as a logged-in player.
    /// Limit: a GitHub account that logs in later with the same login does not rename the player. Revisit if two
    /// players with one name confuse people.
    pub fn set_name(&mut self, token: &str, name: &str, account: Option<i64>) -> ApiResult<()> {
        if self.is_github_login_of_other(name, account)? {
            return Err(ApiError::new(StatusCode::CONFLICT, "That name is a GitHub login. Choose another name."));
        }
        match account {
            Some(account) => {
                self.execute("UPDATE users SET name = $name WHERE github_id = $account", &[("name", &name), ("account", &account)])?
            }
            None => self.execute(
                "INSERT INTO player_names (token, name) VALUES ($token, $name)
                 ON CONFLICT (token) DO UPDATE SET name = excluded.name, updated_at = now()",
                &[("token", &token), ("name", &name)],
            )?,
        };
        Ok(())
    }

    pub fn clear_name(&mut self, token: &str, account: Option<i64>) -> ApiResult<()> {
        match account {
            Some(account) => self.execute("UPDATE users SET name = NULL WHERE github_id = $account", &[("account", &account)])?,
            None => self.execute("DELETE FROM player_names WHERE token = $token", &[("token", &token)])?,
        };
        Ok(())
    }

    /// The picture of an account. Each "generated" makes a new seed, so it also rerolls a generated picture.
    /// "github" and "google" go back to the picture of the login that made the account, so only that one fits: 409.
    pub fn set_avatar(&mut self, account: i64, picture: AvatarPicture) -> ApiResult<()> {
        let seed = (picture == AvatarPicture::Generated).then(|| {
            let mut random = rand::rng();
            (0..AVATAR_SEED_LENGTH).map(|_| char::from_digit(random.random_range(0..16), 16).expect("a hex digit")).collect::<String>()
        });
        let updated = self.execute(
            "UPDATE users SET seed = $seed WHERE github_id = $account AND ($picture = 'generated' OR provider = $picture)",
            &[("seed", &seed), ("account", &account), ("picture", &picture.as_str())],
        )?;
        if updated == 0 {
            return Err(ApiError::new(StatusCode::CONFLICT, format!("This account has no {} picture.", provider_name(picture))));
        }
        Ok(())
    }

    /// The people that the caller blocked, newest first, on every device of the account.
    pub fn blocks(&mut self, token: &str) -> ApiResult<Vec<BlockedPerson>> {
        let owner = self.owner_of(token)?;
        Ok(self.query(
            "FROM blocks SELECT person, name, epoch_ms(created_at) AS at WHERE owner = $owner ORDER BY created_at DESC, person",
            &[("owner", &owner)],
            |row| Ok(BlockedPerson { person: row.get(0)?, name: row.get(1)?, at: row.get(2)? }),
        )?)
    }

    /// Blocking twice keeps the first time and updates the name.
    pub fn block(&mut self, token: &str, person: &str, name: &str) -> ApiResult<()> {
        let owner = self.owner_of(token)?;
        if person_id(&owner) == person {
            return Err(ApiError::bad_request("You cannot block yourself."));
        }
        let counted: Vec<i64> =
            self.query("FROM blocks SELECT count(*) AS n WHERE owner = $owner", &[("owner", &owner)], |row| row.get(0))?;
        if counted.first().copied().unwrap_or(0) >= BLOCKS_KEPT {
            return Err(ApiError::new(StatusCode::CONFLICT, format!("You can block at most {BLOCKS_KEPT} people. Unblock someone first.")));
        }
        self.execute(
            "INSERT INTO blocks (owner, person, name) VALUES ($owner, $person, $name) ON CONFLICT (owner, person) DO UPDATE SET name = excluded.name",
            &[("owner", &owner), ("person", &person), ("name", &name)],
        )?;
        Ok(())
    }

    pub fn unblock(&mut self, token: &str, person: &str) -> ApiResult<()> {
        let owner = self.owner_of(token)?;
        self.execute("DELETE FROM blocks WHERE owner = $owner AND person = $person", &[("owner", &owner), ("person", &person)])?;
        Ok(())
    }

    /// "Hide my stats", on every device of the account.
    pub fn stats_private(&mut self, token: &str) -> ApiResult<bool> {
        let owner = self.owner_of(token)?;
        let found: Vec<String> =
            self.query("FROM private_stats SELECT owner WHERE owner = $owner", &[("owner", &owner)], |row| row.get(0))?;
        Ok(!found.is_empty())
    }

    pub fn set_stats_private(&mut self, token: &str, hidden: bool) -> ApiResult<()> {
        let owner = self.owner_of(token)?;
        let sql = if hidden {
            "INSERT INTO private_stats (owner) VALUES ($owner) ON CONFLICT DO NOTHING"
        } else {
            "DELETE FROM private_stats WHERE owner = $owner"
        };
        self.execute(sql, &[("owner", &owner)])?;
        Ok(())
    }
}

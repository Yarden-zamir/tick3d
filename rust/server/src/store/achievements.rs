//! The achievements of each player over their finished games, and achievement_players for the rarity and the
//! leaderboard (server/store.ts: progressOfTokens, refreshOwners, checkAllAchievements, inviteEvents, inviteFactsOf).
use std::collections::{HashMap, HashSet};

use duckdb::{Connection, ToSql};
use serde_json::Value;
use tick3d_core::game::{EpochMs, Player};
use tick3d_core::session::COMPUTER_TOKEN;

use super::games::{HOST_HAS_GAME, MAX_EPOCH_MS, read_stored, seated_results, token_names, token_params};
use super::{Db, Params, Store, json_list, metric_lists};
use crate::achievements::{
    AchievementGame, Achievements, InputCounts, InviteEvent, Invites, Progress, Rarity, achievement_progress, people_of, rules_value,
};
use crate::error::{ApiError, ApiResult};
use crate::ids::{ACCOUNT_TOKEN_PREFIX, PERSON_ID_LENGTH, PERSON_ID_PREFIX, person_id};
use crate::protocol::{GameMode, parse_metrics};

/// Players per round of refresh_achievements, so the memory and the list of bound tokens stay small.
const ACHIEVEMENT_BATCH: usize = 500;
/// The signature of a row in achievement_players for an inviter without games.
const INVITES_ONLY: &str = "invites";

/// What the store keeps in memory about the achievements.
#[derive(Default)]
pub struct AchievementState {
    /// The progress of each player, by their sorted tokens. A change of games or invites clears it all.
    /// Limit: a clear drops every player's entry. Revisit this if achievement requests take more than about 100 ms.
    cache: HashMap<String, Vec<Progress>>,
    /// The owners (canonical tokens) whose games changed since achievement_players saw them.
    changed: HashSet<String>,
    /// The rarity from achievement_players, until a refresh changes a row.
    rarity: Option<Rarity>,
}

/// The owner of a seat: the account token of a linked device, else the seat token (ownerOfSeat in server/store.ts).
fn owner_of_seat(seat: &str, joined: &str) -> String {
    format!("coalesce($account || lpad({joined}.github_id::VARCHAR, 16, '0'), {seat})")
}

/// The counted games of each player in `source`, as in the rarity (ownedGames in server/store.ts). `counts` is false for a
/// game before the player's last "Reset achievements". Bound values: $account and $computer, and those of `source`.
fn owned_games(source: &str) -> String {
    format!(
        "seats AS (
           SELECT results.id, results.finished_at, unnest([results.player_x, results.player_o]) AS token FROM {source} results WHERE NOT {host}),
         owned AS (
           SELECT DISTINCT seats.id, seats.finished_at, coalesce($account || lpad(pt.github_id::VARCHAR, 16, '0'), seats.token) AS owner
           FROM seats LEFT JOIN player_tokens pt USING (token) WHERE seats.token IS NOT NULL AND seats.token <> $computer),
         counted AS (
           SELECT owned.*, r.reset_at IS NULL OR owned.finished_at > r.reset_at AS counts FROM owned LEFT JOIN achievement_resets r USING (owner))",
        host = *HOST_HAS_GAME
    )
}

/// The games behind a row of achievement_players. A new or removed achievement changes it too ($rules). The text is the
/// same as in server/store.ts, so both servers write the same signatures.
const SIGNATURE: &str = "md5($rules) || ':' || count(*) FILTER (counts) || ':' || coalesce(bit_xor(hash(id)) FILTER (counts), 0)";
const OWNERS: &str = "CAST($owners AS JSON)::VARCHAR[]";

/// One result row as the rules read it: the link, the stored document, the metrics, the finish time and the owner of each seat.
struct GameRow {
    public_id: Option<String>,
    doc: String,
    metrics: Option<String>,
    finished: EpochMs,
    owner_x: Option<String>,
    owner_o: Option<String>,
}

fn game_row(row: &duckdb::Row, first: usize) -> duckdb::Result<GameRow> {
    Ok(GameRow {
        public_id: row.get(first)?,
        doc: row.get(first + 1)?,
        metrics: row.get(first + 2)?,
        finished: row.get(first + 3)?,
        owner_x: row.get(first + 4)?,
        owner_o: row.get(first + 5)?,
    })
}

const GAME_ROW_COLUMNS: &str =
    "results.public_id, results.doc::JSON::VARCHAR, results.metrics::JSON::VARCHAR, epoch_ms(results.finished_at)";

/// One finished game for the player who holds the seats where `mine` is true (achievementGame in server/store.ts).
/// The invites between the player and the opponent come later, from invite_facts_of.
fn achievement_game(row: &GameRow, mine_x: bool, mine_o: bool) -> ApiResult<AchievementGame> {
    if !mine_x && !mine_o {
        return Err(ApiError::fault("an achievement game has no seat of the player"));
    }
    let stored = read_stored(&serde_json::from_str(&row.doc).map_err(ApiError::fault)?, MAX_EPOCH_MS)?;
    // A friend game holds this player on both seats.
    let you = match (mine_x, mine_o) {
        (true, true) => None,
        (true, false) => Some(Player::X),
        _ => Some(Player::O),
    };
    let theirs = match you {
        Some(Player::X) => row.owner_o.as_deref(),
        Some(Player::O) => row.owner_x.as_deref(),
        None => None,
    };
    let person = matches!(stored.mode, GameMode::Online | GameMode::Nearby);
    let opponent = theirs.filter(|theirs| person && *theirs != COMPUTER_TOKEN).map(str::to_owned);
    // The metrics belong to the device that uploaded the result. In a computer game, that is the player.
    let input = match (&row.metrics, stored.mode) {
        (Some(metrics), GameMode::Computer) => {
            let parsed = parse_metrics(metric_lists(), &serde_json::from_str::<Value>(metrics).map_err(ApiError::fault)?);
            parsed.and_then(|metrics| input_of(&metrics["input"]))
        }
        _ => None,
    };
    Ok(AchievementGame {
        id: row.public_id.clone(),
        mode: stored.mode,
        game: stored.game,
        you,
        difficulty: stored.difficulty,
        options: stored.options,
        tuned: stored.tuned,
        finished_at: row.finished,
        opponent,
        input,
        invited_opponent_at: None,
        invited_by_opponent_at: None,
    })
}

/// The input counts of metrics that passed parse_metrics.
fn input_of(input: &Value) -> Option<InputCounts> {
    Some(InputCounts { board: input["board"].as_u64()?, keypad: input["keypad"].as_u64()?, voice: input["voice"].as_u64()? })
}

/// An invite event with the inviter and the tokens of the invited person: the token, the owner and the account,
/// without the email and the code.
struct InviteRow {
    invited_by: String,
    event: InviteEvent,
    tokens: Vec<String>,
}

/// The first invite in each direction between the player and one opponent.
#[derive(Clone, Copy, Default)]
struct Bond {
    invited_opponent_at: Option<EpochMs>,
    invited_by_opponent_at: Option<EpochMs>,
}

/// What the invites tell the rules about one player.
struct InviteFacts {
    invites: Invites,
    bonds: HashMap<String, Bond>,
}

fn persons_of_tokens<'a>(tokens: impl IntoIterator<Item = &'a String>) -> HashSet<String> {
    tokens.into_iter().map(|token| person_id(token)).collect()
}

fn opponents_of(games: &[AchievementGame]) -> Vec<String> {
    let mut seen = HashSet::new();
    games.iter().filter_map(|game| game.opponent.clone()).filter(|opponent| seen.insert(opponent.clone())).collect()
}

/// inviteFactsOf in server/store.ts, for the player with these `tokens` (all of them, the owner too):
/// - invites: the people that the player invited, and the people that those people invited in turn, after the last
///   "Reset achievements" (`since`). The events of one person count once. An invite of the player counts for nobody.
/// - bonds: the first invite in each direction between the player and each opponent, at any time. `opponents` holds the
///   tokens of each opponent, by its canonical token.
///
/// Limit: an invited person counts by token and account only. A claim from before the token columns (only an email)
/// links nobody to an opponent and brings no second invite. Revisit this if such players report a missing unlock.
fn invite_facts_of(
    events: &[InviteRow],
    tokens: &[String],
    opponents: &HashMap<String, Vec<String>>,
    since: Option<EpochMs>,
) -> InviteFacts {
    if events.is_empty() {
        return InviteFacts { invites: Invites::default(), bonds: HashMap::new() };
    }
    let mine: HashSet<&String> = tokens.iter().collect();
    let persons = persons_of_tokens(tokens);
    let after = |at: EpochMs| since.is_none_or(|since| at > since);
    let sent: Vec<&InviteRow> = events.iter().filter(|event| persons.contains(&event.invited_by)).collect();
    let mut second = Vec::new();
    for first in &sent {
        let theirs = persons_of_tokens(&first.tokens);
        for next in events {
            let own = next.tokens.iter().any(|token| mine.contains(token) || first.tokens.contains(token));
            // The second person got the game after the first one: that is when the chain is whole.
            let at = next.event.at.max(first.event.at);
            if theirs.contains(&next.invited_by) && !own && after(at) {
                second.push(InviteEvent { keys: next.event.keys.clone(), at });
            }
        }
    }
    let first_at = |found: Vec<&InviteRow>| found.iter().map(|event| event.event.at).min();
    let bonds = opponents
        .iter()
        .map(|(opponent, their_tokens)| {
            let theirs = persons_of_tokens(their_tokens);
            let bond = Bond {
                invited_opponent_at: first_at(sent.iter().copied().filter(|event| event.tokens.contains(opponent)).collect()),
                invited_by_opponent_at: first_at(
                    events
                        .iter()
                        .filter(|event| theirs.contains(&event.invited_by) && event.tokens.iter().any(|token| mine.contains(token)))
                        .collect(),
                ),
            };
            (opponent.clone(), bond)
        })
        .collect();
    let direct: Vec<InviteEvent> = sent
        .iter()
        .filter(|event| after(event.event.at))
        .map(|event| InviteEvent { keys: event.event.keys.clone(), at: event.event.at })
        .collect();
    InviteFacts { invites: Invites { direct: people_of(&direct), second: people_of(&second) }, bonds }
}

/// The progress of `games` with their invite bonds.
fn progress_with(mut games: Vec<AchievementGame>, facts: &InviteFacts) -> ApiResult<Vec<Progress>> {
    for game in &mut games {
        let bond = game.opponent.as_ref().and_then(|opponent| facts.bonds.get(opponent)).copied().unwrap_or_default();
        game.invited_opponent_at = bond.invited_opponent_at;
        game.invited_by_opponent_at = bond.invited_by_opponent_at;
    }
    achievement_progress(&games, &facts.invites)
}

/// The owners whose achievements changed and the owners without games, from the reader (checkAllAchievements).
fn read_check(conn: &Connection) -> ApiResult<(Vec<String>, Vec<String>)> {
    let rules = rules_value();
    let account = ACCOUNT_TOKEN_PREFIX;
    let computer = COMPUTER_TOKEN;
    let read =
        |sql: &str, params: Params| -> duckdb::Result<Vec<String>> { conn.prepare(sql)?.query_map(params, |row| row.get(0))?.collect() };
    let changed = read(
        &format!(
            "WITH {}, current AS (SELECT owner, {SIGNATURE} AS signature FROM counted GROUP BY owner)
             SELECT owner FROM current LEFT JOIN achievement_players p USING (owner) WHERE p.signature IS DISTINCT FROM current.signature",
            owned_games("results")
        ),
        &[("account", &account), ("computer", &computer), ("rules", &rules)],
    )?;
    let gone = read(
        &format!("FROM achievement_players SELECT owner WHERE owner NOT IN (WITH {} SELECT owner FROM owned)", owned_games("results")),
        &[("account", &account), ("computer", &computer)],
    )?;
    Ok((changed, gone))
}

impl Db {
    /// Marks the games of these owners as changed: their row in achievement_players fills again before the next read.
    pub(super) fn games_changed(&mut self, owners: impl IntoIterator<Item = String>) {
        self.achievement_state.cache.clear();
        self.achievement_state.changed.extend(owners);
    }

    /// Every invite event: a claimed tester code with an inviter, and a copy of the Android app with an inviter.
    /// The keys name the human for people_of: the device token and the owner at the time of the event, the account that
    /// holds the device now, and the email of a claim. A claim from before the token columns has only its email, or its code.
    /// Limit: it reads every invite, a few hundred rows at most now. Revisit this past 10,000 rows.
    fn invite_events(&self) -> ApiResult<Vec<InviteRow>> {
        let found = self.query(
            "FROM tester_codes LEFT JOIN player_tokens linked ON linked.token = claimed_token
               SELECT invited_by, claimed_token AS token, claimed_owner AS owner,
                 CASE WHEN linked.github_id IS NULL THEN NULL ELSE $account || lpad(linked.github_id::VARCHAR, 16, '0') END AS account,
                 lower(email) AS email, code, epoch_ms(claimed_at) AS at
             WHERE invited_by IS NOT NULL AND claimed_at IS NOT NULL
             UNION ALL
             FROM app_copies LEFT JOIN player_tokens linked ON linked.token = app_copies.token
               SELECT invited_by, app_copies.token, owner,
                 CASE WHEN linked.github_id IS NULL THEN NULL ELSE $account || lpad(linked.github_id::VARCHAR, 16, '0') END,
                 NULL, NULL, epoch_ms(opened_at)
             WHERE invited_by IS NOT NULL",
            &[("account", &ACCOUNT_TOKEN_PREFIX)],
            |row| {
                let texts: [Option<String>; 6] = [row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?];
                Ok((texts, row.get::<_, EpochMs>(6)?))
            },
        )?;
        found
            .into_iter()
            .map(|([invited_by, token, owner, account, email, code], at)| {
                let invited_by = invited_by.ok_or_else(|| ApiError::fault("an invite event has no inviter"))?;
                let mut keys: Vec<String> = Vec::new();
                keys.extend(token.iter().map(|token| format!("t:{token}")));
                keys.extend(owner.iter().map(|owner| format!("o:{owner}")));
                keys.extend(account.iter().map(|account| format!("o:{account}")));
                keys.extend(email.iter().map(|email| format!("e:{email}")));
                if keys.is_empty() {
                    let code = code.ok_or_else(|| ApiError::fault("an invite event names nobody"))?;
                    keys.push(format!("c:{code}"));
                }
                let tokens = [token, owner, account].into_iter().flatten().collect();
                Ok(InviteRow { invited_by, event: InviteEvent { keys, at }, tokens })
            })
            .collect()
    }

    /// The tokens of each owner (a canonical token): the owner itself, and the device tokens of an account.
    fn tokens_of_owners(&self, owners: &[String]) -> ApiResult<HashMap<String, Vec<String>>> {
        if owners.is_empty() {
            return Ok(HashMap::new());
        }
        let linked: Vec<(String, String)> = self.query(
            &format!(
                "SELECT token, owner FROM (FROM player_tokens SELECT token, $account || lpad(github_id::VARCHAR, 16, '0') AS owner)
                 WHERE list_contains({OWNERS}, owner)"
            ),
            &[("owners", &json_list(owners)), ("account", &ACCOUNT_TOKEN_PREFIX)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut tokens: HashMap<String, Vec<String>> = owners.iter().map(|owner| (owner.clone(), vec![owner.clone()])).collect();
        for (token, owner) in linked {
            tokens.get_mut(&owner).expect("the query keeps the asked owners").push(token);
        }
        Ok(tokens)
    }

    /// The canonical tokens of the players behind these person ids: an account (by any of its tokens) or a device
    /// without an account that held a seat (seat_people). A person without either has no row in achievement_players.
    fn owners_of_persons(&self, persons: &[String]) -> ApiResult<Vec<String>> {
        if persons.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self.query(
            &format!(
                "SELECT DISTINCT $account || lpad(github_id::VARCHAR, 16, '0') AS owner FROM player_tokens
                 WHERE list_contains(CAST($persons AS JSON)::VARCHAR[], left(sha256($prefix || token), {PERSON_ID_LENGTH}))
                   OR list_contains(CAST($persons AS JSON)::VARCHAR[], left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), {PERSON_ID_LENGTH}))
                 UNION
                 SELECT token AS owner FROM seat_people WHERE list_contains(CAST($persons AS JSON)::VARCHAR[], person) AND token NOT IN (FROM player_tokens SELECT token)"
            ),
            &[("persons", &json_list(persons)), ("prefix", &PERSON_ID_PREFIX), ("account", &ACCOUNT_TOKEN_PREFIX)],
            |row| row.get(0),
        )?)
    }

    /// A new invite of the person `by` changes the invite achievements of `by`, and the Family tree of the people who invited `by`.
    pub(super) fn invite_changed(&mut self, by: &str) -> ApiResult<()> {
        let mut persons = vec![by.to_owned()];
        for event in self.invite_events()? {
            if persons_of_tokens(&event.tokens).contains(by) {
                persons.push(event.invited_by);
            }
        }
        let owners = self.owners_of_persons(&persons)?;
        self.games_changed(owners);
        Ok(())
    }

    fn reset_of(&self, owner: &str) -> ApiResult<Option<EpochMs>> {
        Ok(self
            .query("FROM achievement_resets SELECT epoch_ms(reset_at) WHERE owner = $owner", &[("owner", &owner)], |row| row.get(0))?
            .into_iter()
            .next())
    }

    /// The achievements of the player `owner` with these tokens, over every finished game on all their devices since
    /// their last reset, and the invites of these tokens.
    /// A Nearby guest counts the host's copy of the game, as in the history.
    /// Limit: the guest's own copy has no host seat, so a guest sees the host as the opponent only after the host
    /// uploads. Revisit this if Nearby guests report missing progress on the goals about people.
    fn progress_of_tokens(&mut self, owner: &str, tokens: &[String]) -> ApiResult<Vec<Progress>> {
        let mut sorted = tokens.to_vec();
        sorted.sort();
        let key = sorted.join(" ");
        if let Some(cached) = self.achievement_state.cache.get(&key) {
            return Ok(cached.clone());
        }
        let names = token_names(tokens);
        let mut params = token_params(&names, tokens);
        params.push(("account", &ACCOUNT_TOKEN_PREFIX as &dyn ToSql));
        let found = self.query(
            &format!(
                "FROM {} results LEFT JOIN player_tokens px ON px.token = results.player_x LEFT JOIN player_tokens po ON po.token = results.player_o
                 SELECT results.player_x, results.player_o, {GAME_ROW_COLUMNS}, {}, {} WHERE NOT {}",
                seated_results(tokens.len()),
                owner_of_seat("results.player_x", "px"),
                owner_of_seat("results.player_o", "po"),
                *HOST_HAS_GAME
            ),
            &params,
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, game_row(row, 2)?)),
        )?;
        let reset = self.reset_of(owner)?;
        let own: HashSet<&String> = tokens.iter().collect();
        let mine = |seat: &Option<String>| seat.as_ref().is_some_and(|seat| own.contains(seat));
        let games = found
            .iter()
            .filter(|(_, _, row)| reset.is_none_or(|reset| row.finished > reset))
            .map(|(x, o, row)| achievement_game(row, mine(x), mine(o)))
            .collect::<ApiResult<Vec<_>>>()?;
        let events = self.invite_events()?;
        let opponents = if events.is_empty() { HashMap::new() } else { self.tokens_of_owners(&opponents_of(&games))? };
        let facts = invite_facts_of(&events, tokens, &opponents, reset);
        let progress = progress_with(games, &facts)?;
        self.achievement_state.cache.insert(key, progress.clone());
        Ok(progress)
    }

    /// Fills the rows of these owners again from their games, through the seat indexes. An owner without games (a device
    /// that joined an account) loses its row.
    fn refresh_owners(&mut self, owners: &[String]) -> ApiResult<()> {
        let tokens_of = self.tokens_of_owners(owners)?;
        let mut tokens: Vec<String> = tokens_of.values().flatten().cloned().collect::<HashSet<_>>().into_iter().collect();
        tokens.sort();
        let owners_json = json_list(owners);
        // A device that joined an account counts as the account, so it keeps no row of its own, also with invites.
        let joined: HashSet<String> = self
            .query(
                &format!("FROM player_tokens SELECT token WHERE list_contains({OWNERS}, token) AND token <> $account || lpad(github_id::VARCHAR, 16, '0')"),
                &[("owners", &owners_json), ("account", &ACCOUNT_TOKEN_PREFIX)],
                |row| row.get(0),
            )?
            .into_iter()
            .collect();
        let source = seated_results(tokens.len());
        let names = token_names(&tokens);
        let rules = rules_value();
        let mut params = token_params(&names, &tokens);
        params.extend([
            ("account", &ACCOUNT_TOKEN_PREFIX as &dyn ToSql),
            ("computer", &COMPUTER_TOKEN as &dyn ToSql),
            ("owners", &owners_json as &dyn ToSql),
        ]);
        let found = self.query(
            &format!(
                "WITH {}
                 SELECT counted.owner, {GAME_ROW_COLUMNS}, {}, {}
                 FROM counted JOIN {source} results USING (id)
                   LEFT JOIN player_tokens px ON px.token = results.player_x LEFT JOIN player_tokens po ON po.token = results.player_o
                 WHERE counted.counts AND list_contains({OWNERS}, counted.owner)",
                owned_games(&source),
                owner_of_seat("results.player_x", "px"),
                owner_of_seat("results.player_o", "po"),
            ),
            &params,
            |row| Ok((row.get::<_, String>(0)?, game_row(row, 1)?)),
        )?;
        params.push(("rules", &rules as &dyn ToSql));
        let signatures: HashMap<String, String> = self
            .query(
                &format!(
                    "WITH {} SELECT owner, {SIGNATURE} AS signature FROM counted WHERE list_contains({OWNERS}, owner) GROUP BY owner",
                    owned_games(&source)
                ),
                &params,
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .into_iter()
            .collect();
        // The invites, as in progress_of_tokens. Most refreshes find no invited claim.
        let claims = self.invite_events()?;
        let resets: HashMap<String, EpochMs> = if claims.is_empty() {
            HashMap::new()
        } else {
            self.query(
                &format!("FROM achievement_resets SELECT owner, epoch_ms(reset_at) WHERE list_contains({OWNERS}, owner)"),
                &[("owners", &owners_json)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .into_iter()
            .collect()
        };
        let mut played: HashMap<&str, Vec<AchievementGame>> = owners.iter().map(|owner| (owner.as_str(), Vec::new())).collect();
        for (owner, row) in &found {
            let game = achievement_game(row, row.owner_x.as_ref() == Some(owner), row.owner_o.as_ref() == Some(owner))?;
            played
                .get_mut(owner.as_str())
                .ok_or_else(|| ApiError::fault("a refresh found a game of an owner that it did not ask for"))?
                .push(game);
        }
        let all: Vec<AchievementGame> = played.values().flatten().cloned().collect();
        let opponents = if claims.is_empty() { HashMap::new() } else { self.tokens_of_owners(&opponents_of(&all))? };
        let mut written: Vec<(String, String, Vec<&'static str>)> = Vec::new();
        for owner in owners {
            if joined.contains(owner) {
                continue;
            }
            let own_tokens = tokens_of.get(owner).cloned().unwrap_or_else(|| vec![owner.clone()]);
            let facts = invite_facts_of(&claims, &own_tokens, &opponents, resets.get(owner).copied());
            let has_invites = !facts.invites.direct.is_empty() || !facts.invites.second.is_empty();
            // A player with games, or an inviter without games, so the rarity counts every holder of an invite achievement.
            let Some(signature) = signatures.get(owner).cloned().or_else(|| has_invites.then(|| INVITES_ONLY.to_owned())) else { continue };
            let mut unlocked: Vec<Progress> = progress_with(played.remove(owner.as_str()).unwrap_or_default(), &facts)?
                .into_iter()
                .filter(|entry| entry.unlocked_at.is_some())
                .collect();
            unlocked.sort_by_key(|entry| std::cmp::Reverse(entry.unlocked_at));
            written.push((owner.clone(), signature, unlocked.into_iter().map(|entry| entry.id).collect()));
        }
        self.execute(&format!("DELETE FROM achievement_players WHERE list_contains({OWNERS}, owner)"), &[("owners", &owners_json)])?;
        if !written.is_empty() {
            let owners = serde_json::to_string(&written.iter().map(|row| &row.0).collect::<Vec<_>>()).expect("texts serialize");
            let signatures = serde_json::to_string(&written.iter().map(|row| &row.1).collect::<Vec<_>>()).expect("texts serialize");
            let unlocked = serde_json::to_string(&written.iter().map(|row| &row.2).collect::<Vec<_>>()).expect("texts serialize");
            self.execute(
                "INSERT INTO achievement_players (owner, signature, unlocked)
                 SELECT unnest(CAST($owners AS JSON)::VARCHAR[]), unnest(CAST($signatures AS JSON)::VARCHAR[]), unnest(CAST($unlocked AS JSON)::VARCHAR[][])",
                &[("owners", &owners), ("signatures", &signatures), ("unlocked", &unlocked)],
            )?;
        }
        self.achievement_state.rarity = None;
        Ok(())
    }

    /// Brings achievement_players up to date for the changed owners.
    pub(super) fn refresh_achievements(&mut self) -> ApiResult<()> {
        let mut owners: Vec<String> = self.achievement_state.changed.drain().collect();
        owners.sort();
        for batch in owners.chunks(ACHIEVEMENT_BATCH) {
            self.refresh_owners(batch)?;
        }
        Ok(())
    }

    /// Compares every player with achievement_players in the background, at the start and after a deletion (which can
    /// change the games of other players: a Nearby guest counts again without the host's copy). The reads run on the
    /// reader; a store job then drops the rows of players without games and marks the changed ones.
    /// Limit: it reads every result, about 10 s at 5,000,000 results in Node, outside the store thread.
    pub(super) fn check_all_achievements(&self) {
        let store = self.store();
        self.runtime.spawn(async move {
            let checked = match store.reader.call(read_check).await {
                Ok((changed, gone)) => store.call(move |db| db.apply_check(changed, gone)).await,
                Err(error) => Err(error),
            };
            if let Err(error) = checked {
                eprintln!("achievement check: {error:?}");
            }
        });
    }

    fn apply_check(&mut self, changed: Vec<String>, gone: Vec<String>) -> ApiResult<()> {
        if !gone.is_empty() {
            self.execute(
                &format!("DELETE FROM achievement_players WHERE list_contains({OWNERS}, owner)"),
                &[("owners", &json_list(&gone))],
            )?;
        }
        self.achievement_state.changed.extend(changed);
        // A signature names games, not invites, so every inviter that the server can find gets a fresh row. That also
        // brings back an inviter without games, whose row went with `gone`. Inviters are few.
        let mut invited: Vec<String> = self.invite_events()?.into_iter().map(|event| event.invited_by).collect();
        invited.sort();
        invited.dedup();
        let owners = self.owners_of_persons(&invited)?;
        self.achievement_state.changed.extend(owners);
        self.achievement_state.rarity = None;
        Ok(())
    }

    /// How many players unlocked each achievement, out of every player with a finished game.
    fn everyones_rarity(&mut self) -> ApiResult<Rarity> {
        self.refresh_achievements()?;
        if let Some(rarity) = &self.achievement_state.rarity {
            return Ok(rarity.clone());
        }
        let players: i64 = self.query("SELECT count(*) FROM achievement_players", &[], |row| row.get(0))?.into_iter().next().unwrap_or(0);
        let counts: HashMap<String, u64> = self
            .query("SELECT id, count(*) FROM (SELECT unnest(unlocked) AS id FROM achievement_players) GROUP BY id", &[], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .into_iter()
            .collect();
        let rarity = Rarity::of(u64::try_from(players).map_err(ApiError::fault)?, counts)?;
        self.achievement_state.rarity = Some(rarity.clone());
        Ok(rarity)
    }

    pub(super) fn achievements_of(&mut self, owner: &str, tokens: &[String]) -> ApiResult<Achievements> {
        let achievements = self.progress_of_tokens(owner, tokens)?;
        // An inviter without games and without a seat is unknown to owners_of_persons, so it gets its row here, before
        // the rarity: an unlocked achievement never shows "0% of players".
        if achievements.iter().any(|entry| entry.unlocked_at.is_some()) {
            let known = self
                .query("FROM achievement_players SELECT owner WHERE owner = $owner", &[("owner", &owner)], |row| row.get::<_, String>(0))?;
            if known.is_empty() {
                self.achievement_state.changed.insert(owner.to_owned());
            }
        }
        Ok(Achievements { achievements, rarity: self.everyones_rarity()? })
    }

    /// The achievements of this player over every finished game on all their linked devices, and their rarity.
    /// A cleared game still counts: an achievement stays once the player earned it.
    pub fn achievements(&mut self, token: &str) -> ApiResult<Achievements> {
        let owner = self.owner_of(token)?;
        let tokens: Vec<String> = self.identity_of(Some(token))?.into_iter().collect();
        self.achievements_of(&owner, &tokens)
    }

    /// "Reset achievements", on every device of the account: from now on, only new games count.
    pub fn reset_achievements(&mut self, token: &str) -> ApiResult<()> {
        let owner = self.owner_of(token)?;
        self.execute(
            "INSERT INTO achievement_resets (owner, reset_at) VALUES ($owner, make_timestamptz($at * 1000))
             ON CONFLICT (owner) DO UPDATE SET reset_at = excluded.reset_at",
            &[("owner", &owner), ("at", &super::now_ms())],
        )?;
        self.games_changed([owner]);
        Ok(())
    }

    /// A handle to this store, for work that a job starts in the background.
    fn store(&self) -> Store {
        Store { jobs: self.jobs.clone(), reader: self.reader.clone() }
    }
}

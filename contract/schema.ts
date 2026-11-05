// The tables of the database. The Rust server runs these statements on every start, in order
// (rust/server/src/store/mod.rs reads them from rust/server/contract.json).
// Each statement is idempotent. To change a table, append a statement such as
// `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ... DEFAULT ...`. Never edit one.
// A session is a VARIANT document (see src/session/format.ts), so most format changes need no SQL at all.
// rust/server/src/store/pruning.rs deletes empty sessions and old reports, moderation log, page faults and deletion notices.
import { CODE_LENGTH } from '../src/protocol.ts';
import { FIELD_SCHEMA } from './fields.ts';

export const SCHEMA = [
  'CREATE SEQUENCE IF NOT EXISTS session_order',
  `CREATE TABLE IF NOT EXISTS sessions (
     code VARCHAR PRIMARY KEY CHECK (length(code) = ${CODE_LENGTH}),
     seq BIGINT NOT NULL DEFAULT nextval('session_order'),
     doc VARIANT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Accounts, with the name and picture of the login that made them (provider). github_id is the
  // account id (see logins): GitHub's id, which stays the same when a player renames the account, or a
  // negative id for an account that a Google login made.
  `CREATE TABLE IF NOT EXISTS users (
     github_id BIGINT PRIMARY KEY,
     login VARCHAR NOT NULL,
     avatar VARCHAR NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The devices of an account. A token is the random id one browser keeps. github_id is the account id (see logins).
  `CREATE TABLE IF NOT EXISTS player_tokens (
     token VARCHAR PRIMARY KEY,
     github_id BIGINT NOT NULL,
     linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Finished games. At first only games played away from the server (computer, friend, Nearby).
  `CREATE TABLE IF NOT EXISTS results (
     id VARCHAR PRIMARY KEY,
     token VARCHAR NOT NULL,
     doc VARIANT NOT NULL,
     finished_at TIMESTAMPTZ NOT NULL,
     received_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Game links, match history and stats. `results` now holds every finished game, online games
  // too, one row per game. `doc` keeps the game; these columns add what queries need.
  // public_id: the id in the game link. player_x and player_o: the token of each seat, or null for
  // the computer and for a Nearby player on another device. Never send a token or `id` to a page.
  // winner, ending and line come from a replay of the game, which SQL cannot do.
  // metrics: what the device saw during the game (see Metrics in src/protocol.ts), or null.
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS public_id VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS player_x VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS player_o VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS winner VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS ending VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS line VARCHAR",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS metrics VARIANT",
  // A unique index allows many NULLs. Rows from before game links have no public id: they show in
  // the history without a link.
  "CREATE UNIQUE INDEX IF NOT EXISTS results_public_id ON results (public_id)",
  // Faults that pages report, for the failures list of the stats page. No token, no address.
  `CREATE TABLE IF NOT EXISTS events (
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     kind VARCHAR NOT NULL,
     message VARCHAR NOT NULL,
     version VARCHAR NOT NULL
   )`,
  // Clear history: a seat that its player cleared. The game stays for the other seat and the stats.
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS hidden_x BOOLEAN",
  "ALTER TABLE results ADD COLUMN IF NOT EXISTS hidden_o BOOLEAN",
  // The metrics of each player's device for an online game, one row per seat (Metrics in src/protocol.ts).
  `CREATE TABLE IF NOT EXISTS seat_metrics (
     public_id VARCHAR NOT NULL,
     seat VARCHAR NOT NULL CHECK (seat IN ('X', 'O')),
     metrics VARIANT NOT NULL,
     received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (public_id, seat)
   )`,
  // Finished runs of the sound practice room (src/practice/practice.ts). `id` comes from the page, so a
  // page can send a run again after a lost answer. `score` is the echo points, or the target count.
  `CREATE TABLE IF NOT EXISTS practice_runs (
     token VARCHAR NOT NULL,
     id VARCHAR NOT NULL,
     mode VARCHAR NOT NULL CHECK (mode IN ('targets', 'echo')),
     preset VARCHAR NOT NULL CHECK (preset IN ('easy', 'normal', 'hard')),
     total_ms INTEGER NOT NULL CHECK (total_ms >= 0),
     round_ms INTEGER[] NOT NULL,
     score INTEGER NOT NULL CHECK (score >= 0),
     finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (token, id)
   )`,
  // The page bundles that deploys built (src/release.ts). The API adds its own build at start, so the
  // stats page names the version that game metrics carry. No player data. A version keeps its first name:
  // a later deploy that leaves the page bundle unchanged (a server or docs change) builds the same version.
  `CREATE TABLE IF NOT EXISTS releases (
     version VARCHAR PRIMARY KEY,
     name VARCHAR NOT NULL,
     released_at TIMESTAMPTZ NOT NULL
   )`,
  // The names that players without a GitHub login chose (parseCustomName in src/protocol.ts).
  // A player without a row shows with the generated name of the token (src/names.ts).
  `CREATE TABLE IF NOT EXISTS player_names (
     token VARCHAR PRIMARY KEY,
     name VARCHAR NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Blocks (report and block, src/page/safety.ts). `owner` is the token of the blocker: the account
  // token when the device is linked, so a block follows the account. `person` is a public person id.
  `CREATE TABLE IF NOT EXISTS blocks (
     owner VARCHAR NOT NULL,
     person VARCHAR NOT NULL,
     name VARCHAR NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (owner, person)
   )`,
  // "Hide my stats" (StatsPrivacy in src/protocol.ts). `owner` is the token of the player: the account
  // token when the device is linked, so the setting follows the account. A row means private.
  `CREATE TABLE IF NOT EXISTS private_stats (
     owner VARCHAR PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // "Reset achievements": only games that finished after `reset_at` count for the achievements of `owner`.
  // `owner` is the token of the player, as in private_stats. "Clear history" does not touch it.
  // The unlocked achievements of each player (owner: a canonical token), for the rarity and the
  // leaderboard. `signature` names the games that made the row (refreshAchievements fills a row again
  // when it changes). Never send an owner to a page.
  `CREATE TABLE IF NOT EXISTS achievement_players (
     owner VARCHAR PRIMARY KEY,
     signature VARCHAR NOT NULL,
     unlocked VARCHAR[] NOT NULL
   )`,
  // The person id of each token that held a seat of a result (personId in src/protocol.ts), so a person view
  // finds a player without an account by a key lookup, not by a hash of every seat. Never send a token to a page.
  `CREATE TABLE IF NOT EXISTS seat_people (
     person VARCHAR PRIMARY KEY,
     token VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS achievement_resets (
     owner VARCHAR PRIMARY KEY,
     reset_at TIMESTAMPTZ NOT NULL
   )`,
  // Reports of a chat message or a person. The text and the name are copies from the time of the
  // report, because the chat keeps only the newest messages. `reporter` is a token: never send it.
  'CREATE SEQUENCE IF NOT EXISTS report_order',
  `CREATE TABLE IF NOT EXISTS reports (
     id BIGINT PRIMARY KEY DEFAULT nextval('report_order'),
     code VARCHAR,
     message INTEGER,
     message_text VARCHAR,
     person VARCHAR,
     person_name VARCHAR,
     reason VARCHAR NOT NULL CHECK (reason IN ('spam', 'abuse', 'name', 'other')),
     note VARCHAR,
     reporter VARCHAR NOT NULL,
     reporter_person VARCHAR NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Every moderation action of a maintainer, so each one can be traced.
  `CREATE TABLE IF NOT EXISTS moderation_log (
     login VARCHAR NOT NULL,
     action VARCHAR NOT NULL CHECK (action IN ('hide-message', 'clear-name')),
     code VARCHAR,
     message INTEGER,
     person VARCHAR,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Delete my data (deleteData) keeps a report that a player filed, without the link to that player.
  'ALTER TABLE reports ALTER COLUMN reporter DROP NOT NULL',
  'ALTER TABLE reports ALTER COLUMN reporter_person DROP NOT NULL',
  // Deletion notices: the person id of each player who deleted their data, and the time. Pages read
  // them (deletedSince) and remove that person from their own copies. pruneOld deletes a notice after a year.
  `CREATE TABLE IF NOT EXISTS deleted_people (
     person VARCHAR PRIMARY KEY,
     deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  ...FIELD_SCHEMA,
  // The Google Play promo codes of the Android closed test (/share, src/share/codes.ts). TESTER_CODES fills
  // the table at start (rust/server/src/tester_codes.rs). A claim stores the email and the name that the tester typed,
  // and no player token. A code that the maintainer gave out by hand has a name and no email.
  // Never send a code or an email in the public list. A maintainer deletes a row by hand on an email request.
  'CREATE SEQUENCE IF NOT EXISTS tester_code_order',
  `CREATE TABLE IF NOT EXISTS tester_codes (
     id INTEGER PRIMARY KEY DEFAULT nextval('tester_code_order'),
     code VARCHAR NOT NULL UNIQUE,
     name VARCHAR,
     email VARCHAR,
     claimed_at TIMESTAMPTZ,
     added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     CHECK ((claimed_at IS NULL) = (name IS NULL) AND (email IS NULL OR name IS NOT NULL))
   )`,
  // The person id of the inviter of a claim (ClaimRequest in src/share/codes.ts), or null. The claim counts for
  // the invite achievements of that person (src/achievements.ts). A self-invite stores null.
  'ALTER TABLE tester_codes ADD COLUMN IF NOT EXISTS invited_by VARCHAR',
  // The device token of the claimer and its owner at the time of the claim (the account token when the device was
  // logged in, else the device token), so the invite events of one person count once (inviteEvents). Tokens: never
  // send them to a page. Null for a claim from before these columns.
  'ALTER TABLE tester_codes ADD COLUMN IF NOT EXISTS claimed_token VARCHAR',
  'ALTER TABLE tester_codes ADD COLUMN IF NOT EXISTS claimed_owner VARCHAR',
  // The bought copies of the paid Android app (src/copies.ts): one row per device (`token`) where the app opened
  // (POST /api/copies). `owner` is the account (or the device) that held the device at the first open. `invited_by`
  // is the inviter that /share kept on that device, or null. The account that holds the device now holds the copy
  // (hasCopyOf), so a copy follows the last login on the app. Tokens: never send them to a page.
  `CREATE TABLE IF NOT EXISTS app_copies (
     token VARCHAR PRIMARY KEY,
     owner VARCHAR NOT NULL,
     invited_by VARCHAR,
     opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'ALTER TABLE app_copies ADD COLUMN IF NOT EXISTS proved BOOLEAN DEFAULT false',
  // The device slots of the iPhone app purchases (rust/server/src/apple_proof.rs): one row per device. `device` is the App
  // Store id of the phone, which the signed purchase proves. `purchase` is `<environment>:<appTransactionId>`, and
  // one purchase holds at most APPLE_SLOTS_PER_PURCHASE rows. `token` is the one player token of the device now.
  // Tokens: never send them to a page.
  `CREATE TABLE IF NOT EXISTS apple_slots (
     device VARCHAR PRIMARY KEY,
     purchase VARCHAR NOT NULL,
     token VARCHAR NOT NULL UNIQUE,
     last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The one-time data changes (runOnce in openStore) that ran on this database, by name.
  `CREATE TABLE IF NOT EXISTS migrations (
     name VARCHAR PRIMARY KEY,
     ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The choices of an account (PlayerInfo in src/protocol.ts): a custom name in place of the login, and
  // the seed of a generated picture in place of the GitHub picture. Null keeps the GitHub value.
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS seed VARCHAR',
  // The logins of each account: GitHub and Google work the same way (LOGIN_PROVIDERS in src/protocol.ts).
  // github_id is the account id. An account that a GitHub login made has the GitHub id. An account that
  // a Google login made has a negative id from account_ids, so it never equals a GitHub id.
  // subject: the GitHub id, or Google's subject id. label: the GitHub login, or null for Google.
  // An account has at most one login of each provider.
  'CREATE SEQUENCE IF NOT EXISTS account_ids',
  `CREATE TABLE IF NOT EXISTS logins (
     provider VARCHAR NOT NULL,
     subject VARCHAR NOT NULL,
     github_id BIGINT NOT NULL,
     label VARCHAR,
     linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (provider, subject),
     UNIQUE (provider, github_id)
   )`,
  // The login that made the account: users.login and users.avatar come from it. A Google account may have no photo.
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS provider VARCHAR DEFAULT 'github'",
  'ALTER TABLE users ALTER COLUMN avatar DROP NOT NULL',
];

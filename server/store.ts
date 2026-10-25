import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { ApplePurchase } from './apple-proof.ts';
import { type DuckDBValue, DuckDBInstance, DuckDBListValue, listValue } from '@duckdb/node-api';
import {
  ACHIEVEMENT_IDS,
  type AchievementGame,
  type AchievementId,
  type AchievementProgress,
  type AchievementRarity,
  type Achievements,
  type Invites,
  achievementProgress,
} from '../src/achievements.ts';
import { DIFFICULTIES } from '../src/ai.ts';
import { NO_LIMIT, type TimeControl } from '../src/clock.ts';
import { type EpochMs, MAX_EPOCH_MS, epochNow, toEpochMs } from '../src/epoch.ts';
import { type LineKind, type Player, lineKind, other, winnerOf } from '../src/game.ts';
import { nameOf } from '../src/names.ts';
import {
  ACCOUNT_TOKEN_PREFIX,
  LOGIN_PROVIDERS,
  type LoginProvider,
  PROVIDER_NAMES,
  AVATAR_SEED_LENGTH,
  type AvatarPicture,
  CODE_ALPHABET,
  CODE_LENGTH,
  type ClientEvent,
  type Code,
  type DeviceGameId,
  type GameId,
  type GameRecord,
  HISTORY_PAGE_SIZE,
  type HistoryEntry,
  type HistoryPage,
  type Metrics,
  type MoveRequest,
  type MyGames,
  type BlockedPerson,
  PERSON_ID_LENGTH,
  PERSON_ID_PREFIX,
  type PersonId,
  REPORT_REASONS,
  type ReportReason,
  type ReportRequest,
  accountNameOf,
  parsePersonId,
  personId,
  type PlayerInfo,
  type PlayerToken,
  type PublicGame,
  type ResultUpload,
  type SeatAction,
  SESSION_MODES,
  type SessionMode,
  type SessionSummary,
  type SessionUpdate,
  type SessionView,
  STATS_PRIVATE_MESSAGE,
  type Leaderboard,
  type Stats,
  type StatsFilter,
  type StatsCard,
  type StatsPerson,
  type Tally,
  ALL_STATS,
  WATCHER_ID_LENGTH,
  isChatEvent,
  isGameRecord,
  parseMatchOptions,
  newGameId,
  isOnlineGameId,
  onlineGameId,
  onlineGameParts,
  outcomeOf,
  parseHistoryPage,
  parsePublicGame,
  parseResultUpload,
  seatIn,
  statsQuery,
  parseMetrics,
  toGame,
} from '../src/protocol.ts';
import { type Records, addLoss } from '../src/records.ts';
import * as core from '../src/session/core.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from '../src/session/format.ts';
import type { PlayoffRequest } from '../src/practice/playoff.ts';
import type { PracticeBoard, PracticeMode, PracticeRun, PresetId } from '../src/practice/practice.ts';
import { DELETED_NAME } from '../src/deletions.ts';
import type { Release } from '../src/release.ts';
import { DATA_TABLES, type DeletedData, STATS_CACHE_MS } from './api-docs.ts';
import { FIELD_SCHEMA, GAME_COLUMN_LIST, GAME_VALUES, METRIC_COLUMN_LIST, METRIC_VALUES, SESSION_SEAT_SET, SESSION_SEAT_VALUES } from './fields.ts';
import { practiceBoard, practiceStats } from './practice.ts';
import { type Rows, bigId, bool, code as codeColumn, deviceGameId, epoch, gameId, int, json, nullable, oneOf, readRow, text } from './sql.ts';
import { computeStats, inTokens, seatedResults, seatedRows, tokenValues } from './stats.ts';
import { leaderRows } from './leaderboard.ts';
import { type InviteEvent, peopleOf } from './invite-people.ts';
import { type ClaimRequest, type ClaimedCode, type TesterCodeEntry, type TesterCodes, hintOf } from '../src/share/codes.ts';
import { gravatarOf } from './tester-codes.ts';
import { type OnWrite, statements } from './statements.ts';

// The claims of tester codes with their emails, for the maintainers only (GET /api/testing/claims).
// `invitedBy` is the person id of the inviter, or null for a claim without an invite.
export type TesterClaims = { claims: { hint: string; name: string; email: string | null; claimedAt: EpochMs; invitedBy: PersonId | null }[] };

// The GitHub account of the maintainer Yarden (login Yarden-zamir). Every code that testers claimed before the
// invite links counts as his invite (the migration 'tester-invites-before-links' in openStore).
const YARDEN_GITHUB_ID = 8178413;

const { SessionError } = core;

function personColumn(value: unknown): PersonId {
  const found = parsePersonId(value);
  if (found === undefined) throw new Error(`not a person id: ${String(value)}`);
  return found;
}
const SEATS = ['X', 'O'] as const satisfies readonly Player[];

// Each statement is idempotent and runs on every start, in order. To change a table, append a
// statement such as `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ... DEFAULT ...`. Never edit one.
// A session is a VARIANT document (see src/session/format.ts), so most format changes need no SQL at all.
// pruneEmpty deletes sessions where no game has a move, pruneOld deletes old reports, moderation log,
// page faults and deletion notices, and deleteFor deletes the data of one player. Games and results
// have no limit until storage calls for one.
const SCHEMA = [
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
  // the table at start (server/tester-codes.ts). A claim stores the email and the name that the tester typed,
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
  // The device slots of the iPhone app purchases (server/apple-proof.ts): one row per device. `device` is the App
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

// The token that a seat holds when a logged-in player takes it. The account has a player_tokens row
// for it (ensureAccountRow), so the joins through player_tokens resolve an account seat to its user.
// The row comes before any seat names the token: at the login, and again before a seat or a logout uses it. Every device of the account holds it
// through identityOf, and a device that logs out does not. It passes the token checks of a stored
// document, so the format does not change. asPlayerToken refuses it as an X-Player value.
const accountToken = (githubId: number | bigint): string => `${ACCOUNT_TOKEN_PREFIX}${String(githubId).padStart(16, '0')}`;
// The account id in an account token. The padding is the same as lpad in SQL, so the sign of a negative id
// (an account that a Google login made) sits after the zeros: "00000000000000-5". The leaderboard reads it the same way.
function accountIdOf(token: string): bigint {
  const digits = token.slice(ACCOUNT_TOKEN_PREFIX.length);
  const start = [...digits].findIndex((char) => char !== '0');
  return BigInt(start === -1 ? '0' : digits.slice(start));
}

export type GitHubUser = { id: number; login: string; avatar: string };
// A Google login: Google's subject id of the account. It stays the same when the player changes the
// Google name or address. The account cookie holds only this id.
export type GoogleUser = { google: string };
// A Google sign-in: the subject id with the name and photo from Google (see googleName in server/auth.ts).
type GoogleProfile = { name: string | null; picture: string | null };
export type GoogleSignIn = GoogleUser & { profile: GoogleProfile };
// A login of an account. The cookie gives a GitHubUser or a GoogleUser, a sign-in a GoogleSignIn.
export type LoginUser = GitHubUser | GoogleUser | GoogleSignIn;

// A stored report as a maintainer reads it (GET /api/reports). It holds person ids, never a token.
export type StoredReport = {
  id: number;
  // Null for a report of a person on the stats page.
  code: Code | null;
  message: number | null;
  text: string | null;
  person: PersonId | null;
  name: string | null;
  reason: ReportReason;
  note: string | null;
  // Null when the reporter deleted their data.
  reporter: PersonId | null;
  reporterLogin: string | null;
  at: EpochMs;
};
export type ModerationAction = {
  login: string;
  action: 'hide-message' | 'clear-name';
  code: Code | null;
  message: number | null;
  person: PersonId | null;
  at: EpochMs;
};
const REPORTS_SHOWN = 200;
export const REMOVED_MESSAGE = 'A moderator removed this message.';
export const DELETED_MESSAGE = 'Deleted by its author.';
// Reports, the moderation log and page faults go after 90 days (pruneOld). Moderation needs a
// report for a few weeks at most. Revisit this if a maintainer needs older reports.
export const REPORTS_KEPT_MS = 90 * 24 * 3_600_000;
// A deletion notice stays for a year, so a device that comes back within a year still cleans its
// copies. Limit: a device that stays away longer keeps them. Revisit this if players ask about it.
export const DELETION_NOTICES_KEPT_MS = 365 * 24 * 3_600_000;
const BLOCKS_KEPT = 500;

type Row = { code: Code; doc: SessionDoc; version: number; stale: boolean };

// The tables of accounts, devices and names. The store caches lookups in them (accountRows in openStore).
const ACCOUNT_TABLES = ['player_tokens', 'player_names', 'users', 'logins'];
const MAX_ACCOUNT_ANSWERS = 10_000;
const MAX_SESSION_ROWS = 2_000;

// A text key for the values of a query: text, numbers, booleans, null, bigints and lists of them.
function valuesKey(values: Record<string, DuckDBValue>): string {
  return JSON.stringify(values, (key, value: unknown) => {
    if (key === '' || value === null || Array.isArray(value) || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    // An object, so a bigint never gets the key of a text value.
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (value instanceof DuckDBListValue) return value.items;
    throw new Error(`no cache key for the value of ${key}`);
  });
}

// Every write passes the same check as every read, so the table never holds a document that cannot
// be read back. This replaces the column CHECK constraints that a document column cannot have.
// A session row from its stored document. `stale` marks a document in an older format.
function rowOf(code: Code, stored: unknown, version: number): Row {
  const format = typeof stored === 'object' && stored !== null && 'format' in stored ? stored.format : undefined;
  return { code, doc: parseDoc(stored), version, stale: format !== CURRENT_FORMAT };
}

function serialize(doc: SessionDoc): string {
  const text = JSON.stringify(doc);
  parseDoc(JSON.parse(text));
  return text;
}

function newCode(): Code {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('') as Code;
}

const emptyTally = (): Tally => ({ played: 0, won: 0, lost: 0, drawn: 0 });

function count(tally: Tally, outcome: 'won' | 'lost' | 'drawn' | 'played'): void {
  tally.played++;
  if (outcome !== 'played') tally[outcome]++;
}

const isFinished = (record: GameRecord) => toGame(record).status.kind !== 'playing';
const isDuplicateKey = (error: unknown) => error instanceof Error && error.message.includes('Duplicate key');
// A unique id is a few random tries away. Twenty failures mean a bug, not bad luck.
const MAX_ID_ATTEMPTS = 20;
// Raise it when a rule in src/achievements.ts changes: every row of achievement_players then fills again.
// A new or removed achievement changes the signatures by itself.
const ACHIEVEMENT_RULES_VERSION = 4;
// The devices that one iPhone app purchase can prove, and the days after which an unused device frees its slot (takeAppleSlot).
const APPLE_SLOTS_PER_PURCHASE = 5;
const APPLE_SLOT_IDLE_DAYS = 90;
// The time to live of an Everyone snapshot is at least this many times the cost of its last refresh.
const SNAPSHOT_COST_FACTOR = 10;
// The signature of a row in achievement_players for an inviter without games (refreshOwners).
const INVITES_ONLY = 'invites';
// Players per replay round of refreshAchievements, so the memory and the list of bound tokens stay small.
const ACHIEVEMENT_BATCH = 500;

// What SQL cannot read from a stored game without a replay.
type Ending = { winner: Player | null; ending: 'won' | 'timeout' | 'draw'; line: LineKind | null };

function endingOf(record: GameRecord): Ending {
  const status = toGame(record).status;
  switch (status.kind) {
    case 'won':
      return { winner: status.winner, ending: 'won', line: lineKind(status.line) };
    case 'timeout':
      return { winner: status.winner, ending: 'timeout', line: null };
    case 'draw':
      return { winner: null, ending: 'draw', line: null };
    case 'playing':
      throw new Error('only a finished game has an ending');
  }
}

// The stored document of a result row: an upload from a device, or an online game that the server recorded.
type StoredGame = Pick<ResultUpload, 'game' | 'you' | 'difficulty' | 'options' | 'tuned'> & { mode: SessionMode };

// `doc` is the parsed JSON of the row.
function readStored(doc: unknown): StoredGame {
  if (typeof doc === 'object' && doc !== null && 'mode' in doc && doc.mode === 'online') {
    const { game } = doc as Record<string, unknown>;
    // A game stored before hideCoordinates reads it as false.
    const options = parseMatchOptions((doc as Record<string, unknown>).options);
    if (!isGameRecord(game) || !isFinished(game) || options === undefined) throw new Error('a stored online game does not parse');
    return { mode: 'online', game, you: null, difficulty: null, options, tuned: false };
  }
  // The finish time was checked when the result arrived.
  const upload = parseResultUpload(doc, MAX_EPOCH_MS);
  if (upload === undefined) throw new Error('a stored result does not parse');
  return upload;
}

// The seat tokens of a result from a device. Its player holds `you`, or both seats in a friend game.
// A Nearby host also names the guest on the other seat.
const seatTokens = (token: string, you: Player | null, guest: string | null): Record<Player, string | null> => ({
  X: you === 'O' ? guest : token,
  O: you === 'X' ? guest : token,
});

// The columns of users that make a PlayerInfo, and their shape. All are nullable for a LEFT JOIN.
const ACCOUNT_COLUMN_LIST = 'provider, login, avatar, name, seed';
const ACCOUNT_COLUMNS = { provider: nullable(oneOf(LOGIN_PROVIDERS)), login: nullable(text), avatar: nullable(text), name: nullable(text), seed: nullable(text) };
type AccountRow = { provider: LoginProvider | null; login: string | null; avatar: string | null; name: string | null; seed: string | null };

// The account of a seat from a LEFT JOIN of users: no login means no account.
// A Google name is often a real name, so after a rename the custom name takes its place: nobody else sees it.
function accountOf({ provider, login, avatar, name, seed }: AccountRow): PlayerInfo | null {
  if (login === null) return null;
  if (provider === null) throw new Error('a stored account has no provider');
  if (provider === 'github' && avatar === null) throw new Error('a stored GitHub account has no avatar');
  return { provider, login: provider === 'google' && name !== null ? name : login, avatar, name, seed };
}

// True for the result of a Nearby guest when the host's result of the same game names the guest.
// Both devices send a result, so the guest's history then lists the host's row only: it knows both players.
// The two copies can differ in the time of the last move by some milliseconds, so the match uses the
// moves and a finish within 10 minutes. Two games of the same two players with the same moves inside
// 10 minutes then count as one. Revisit this if a result ever carries a shared game id from the host.
// The guest rows that have a host row, as one join of the few Nearby rows, once per query: a correlated
// EXISTS made DuckDB join every result (12.8 s at 5,000,000 results, against 0.3 s for this form). One equality
// join per host seat, so DuckDB can hash them.
const guestCopies = (seat: 'player_x' | 'player_o') => `SELECT guest.id FROM results guest JOIN results host ON host.${seat} = guest.token
  WHERE guest.nearby_role = 'guest' AND host.mode = 'nearby' AND host.nearby_role = 'host' AND host.token <> guest.token
    AND host.moves = guest.moves AND abs(epoch_ms(host.finished_at) - epoch_ms(guest.finished_at)) < 600000`;
const HOST_HAS_GAME = `(results.nearby_role IS NOT DISTINCT FROM 'guest' AND results.id IN (${guestCopies('player_x')} UNION ${guestCopies('player_o')}))`;

// Joins the account of each seat of a result row: x_provider, x_login, x_avatar, x_name, x_seed, and the same for o.
const SEAT_ACCOUNTS = `
  LEFT JOIN player_tokens tx ON tx.token = results.player_x LEFT JOIN users ux ON ux.github_id = tx.github_id
  LEFT JOIN player_tokens t_o ON t_o.token = results.player_o LEFT JOIN users uo ON uo.github_id = t_o.github_id`;
const SEAT_ACCOUNT_COLUMNS =
  'ux.provider AS x_provider, ux.login AS x_login, ux.avatar AS x_avatar, ux.name AS x_name, ux.seed AS x_seed, uo.provider AS o_provider, uo.login AS o_login, uo.avatar AS o_avatar, uo.name AS o_name, uo.seed AS o_seed';
// The shape of SEAT_ACCOUNT_COLUMNS, and of the seat tokens (player_x AS token_x, player_o AS token_o).
// A seat token is null for a seat without a known player.
const SEAT_SHAPE = {
  x_provider: nullable(oneOf(LOGIN_PROVIDERS)),
  x_login: nullable(text),
  x_avatar: nullable(text),
  x_name: nullable(text),
  x_seed: nullable(text),
  o_provider: nullable(oneOf(LOGIN_PROVIDERS)),
  o_login: nullable(text),
  o_avatar: nullable(text),
  o_name: nullable(text),
  o_seed: nullable(text),
  token_x: nullable(text),
  token_o: nullable(text),
};

type StoreOptions = {
  now?: () => EpochMs;
  // The player tokens that have a session open now. The HTTP layer knows; tests pass nothing.
  open?: (code: Code) => readonly PlayerToken[];
  // Runs after every write to a session, also a write during a read (a timeout, a format upgrade).
  // The HTTP layer tells the open pages of the session to fetch it again.
  onChange?: (code: Code) => void;
};

export async function openStore(
  path: string,
  { now = epochNow, open = () => [], onChange = () => undefined }: StoreOptions = {},
) {
  // Watcher ids hide the token behind a keyed hash. The key lives in this process only, so the ids
  // change on a restart. That is fine: pages read the list again with every change.
  const watcherKey = randomBytes(32);
  const watcherId = (code: Code, token: string) =>
    createHmac('sha256', watcherKey).update(`${code}:${token}`).digest('hex').slice(0, WATCHER_ID_LENGTH);
  // The API container is small, so cap memory and threads below DuckDB's defaults (80% of RAM, all cores).
  // A new file defaults to the v1.0 storage format for old readers, but VARIANT needs v1.5 storage.
  const instance = await DuckDBInstance.create(path, {
    memory_limit: '256MB',
    threads: '2',
    storage_compatibility_version: 'v1.5.0',
  });
  // The rows of the account and name lookups (accountRows), by query and values. Only this store writes those
  // tables, so a write that names one of them, or a rollback, empties the map. This holds while one process
  // uses the file, as the store queue already assumes.
  // Limit: the map empties at MAX_ACCOUNT_ANSWERS entries. Revisit if a profile shows these lookups missing often.
  const accountAnswers = new Map<string, readonly Record<string, unknown>[]>();
  // Counts the changes, so a lookup that ran during a change does not keep its answer.
  let accountChanges = 0;
  // The last known row of each session, so a read needs no query. A write to `sessions` drops the row of its
  // $code, or every row when it has none. save then keeps the row that it wrote. Same one-process rule as above.
  // Limit: beyond MAX_SESSION_ROWS the least recently used row goes. Revisit if the API memory grows with it.
  const sessionRows = new Map<string, Row>();
  let sessionChanges = 0;
  const onWrite: OnWrite = (sql, values) => {
    const rollback = sql.trim().toUpperCase().startsWith('ROLLBACK');
    if (rollback || ACCOUNT_TABLES.some((table) => sql.includes(table))) {
      accountAnswers.clear();
      accountChanges++;
    }
    if (rollback || sql.includes('sessions')) {
      const code = values?.code;
      if (!rollback && typeof code === 'string') sessionRows.delete(code);
      else sessionRows.clear();
      sessionChanges++;
    }
  };
  const db = statements(await instance.connect(), onWrite);
  for (const statement of SCHEMA) await db.run(statement);
  // DuckDB 1.5.6 cannot replay ALTER ... DROP NOT NULL on `reports` (its id defaults to nextval) from the
  // write-ahead log. SCHEMA runs that ALTER on every start, so a crash before the next checkpoint leaves a file
  // that does not open. A checkpoint right after SCHEMA keeps those statements out of the log.
  // Revisit when a DuckDB release replays it, or when SCHEMA no longer runs ALTER statements on each start.
  await db.run('CHECKPOINT');

  // Runs `task` once per database: the migrations table keeps the name, so a later start skips it.
  // The task and the name go in one transaction, so a failed task runs again on the next start.
  async function runOnce(name: string, task: () => Promise<void>): Promise<void> {
    await db.run('BEGIN TRANSACTION');
    try {
      const added = await db.runAndReadAll('INSERT INTO migrations (name) VALUES ($name) ON CONFLICT DO NOTHING RETURNING name', { name });
      if (added.getRowObjectsJS().length > 0) await task();
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  }
  // The claims from before the invite links have no inviter. They count as invites of Yarden, once: a later
  // claim without an invite stays without one. The codes that Yarden gave to himself (by hand, so without email) stay without one.
  await runOnce('tester-invites-before-links', async () => {
    await db.run("UPDATE tester_codes SET invited_by = $person WHERE claimed_at IS NOT NULL AND invited_by IS NULL AND NOT (email IS NULL AND name = 'Yarden')", {
      person: await personId(accountToken(YARDEN_GITHUB_ID)),
    });
  });

  // The GitHub accounts from before the logins table get their GitHub login row, once.
  await runOnce('github-logins', async () => {
    await db.run("UPDATE users SET provider = 'github' WHERE provider IS NULL");
    await db.run("INSERT INTO logins (provider, subject, github_id, label) SELECT 'github', github_id::VARCHAR, github_id, login FROM users ON CONFLICT DO NOTHING");
  });

  // DuckDB calls are async, so two requests could interleave a read and a write. A queue runs
  // store operations one at a time, which keeps each read-check-write atomic in this process.
  // Revisit this if the API ever runs more than one process against the same file.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  const rows: Rows = async (sql, values, shape) => (await db.runAndReadAll(sql, values)).getRowObjectsJS().map((row) => readRow(row, shape));

  // `rows` for a lookup that reads only ACCOUNT_TABLES. Most store calls repeat the same few lookups.
  const accountRows: Rows = async (sql, values, shape) => {
    const key = `${sql}\n${valuesKey(values)}`;
    let found = accountAnswers.get(key);
    if (found === undefined) {
      const changes = accountChanges;
      found = (await db.runAndReadAll(sql, values)).getRowObjectsJS();
      if (accountAnswers.size >= MAX_ACCOUNT_ANSWERS) accountAnswers.clear();
      if (changes === accountChanges) accountAnswers.set(key, found);
    }
    return found.map((row) => readRow(row, shape));
  };

  // A second connection for the answers about every player (the Everyone stats and the leaderboard). They read
  // every game, so they run here, one at a time, and the store queue never waits for them. Each query reads a
  // consistent view of the data while the main connection writes.
  const reader = statements(await instance.connect());
  const readRows: Rows = async (sql, values, shape) => (await reader.runAndReadAll(sql, values)).getRowObjectsJS().map((row) => readRow(row, shape));
  let readQueue: Promise<unknown> = Promise.resolve();
  // Set by close: no new background work starts.
  let closing = false;
  function inBackground<T>(task: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('the store is closing'));
    const run = readQueue.then(task, task);
    readQueue = run.catch(() => undefined);
    return run;
  }

  // Keeps `row` as the most recently used row of its session.
  function keepRow(row: Row): Row {
    sessionRows.delete(row.code);
    sessionRows.set(row.code, row);
    const oldest = sessionRows.keys().next();
    if (sessionRows.size > MAX_SESSION_ROWS && oldest.done !== true) sessionRows.delete(oldest.value);
    return row;
  }

  async function loadRaw(code: Code): Promise<Row> {
    const known = sessionRows.get(code);
    if (known !== undefined) return keepRow(known);
    const changes = sessionChanges;
    const [found] = await rows('FROM sessions SELECT doc::JSON AS doc, version WHERE code = $code', { code }, { doc: json, version: int });
    if (found === undefined) throw new SessionError(404, `No game with code ${code}.`);
    const row = rowOf(code, found.doc, found.version);
    // A write during the read can make this row old.
    return changes === sessionChanges ? keepRow(row) : row;
  }

  // The achievements of each player, by their sorted tokens. A new or deleted result clears it all.
  // Limit: a clear drops every player's entry. Revisit this if achievement requests take more than about 100 ms.
  const achievementCache = new Map<string, AchievementProgress[]>();
  // The owners (canonical tokens) whose games changed since achievement_players saw them. Each write that
  // changes the games of a player adds them. checkAllAchievements adds the changes that this process did not
  // see (a deploy, a stop before a refresh).
  const changedOwners = new Set<string>();
  // The rarity from achievement_players, until a refresh changes a row.
  let rarityCache: AchievementRarity | undefined;

  // A Nearby guest counts the host's copy of the game, as in the history. owner_x and owner_o are the
  // canonical tokens of the seats (see ownerOfSeat), which name the opponent.
  // Limit: the guest's own copy has no host seat, so a guest sees the host as the opponent only after the
  // host uploads. Revisit this if Nearby guests report missing progress on the goals about people.
  const achievementRows = (source: string) => `FROM ${source} results
      LEFT JOIN player_tokens px ON px.token = results.player_x LEFT JOIN player_tokens po ON po.token = results.player_o
    SELECT results.public_id, results.doc::JSON AS doc, results.metrics::JSON AS metrics, epoch_ms(results.finished_at) AS finished,
      results.player_x AS token_x, results.player_o AS token_o,
      ${ownerOfSeat('results.player_x', 'px')} AS owner_x, ${ownerOfSeat('results.player_o', 'po')} AS owner_o
    WHERE NOT ${HOST_HAS_GAME}`;
  const ACHIEVEMENT_COLUMNS = {
    public_id: nullable(gameId),
    doc: json,
    metrics: nullable(json),
    finished: epoch,
    token_x: nullable(text),
    token_o: nullable(text),
    owner_x: nullable(text),
    owner_o: nullable(text),
  };

  // One finished game as the rules read it, for the player who holds the seats where `mine` is true.
  // The opponent is the canonical token of the other seat of an online or Nearby game. The invites between the
  // player and the opponent come from inviteFactsOf.
  type AchievementRow = { public_id: GameId | null; doc: unknown; metrics: unknown; finished: EpochMs; owner_x: string | null; owner_o: string | null };
  function achievementGame(row: AchievementRow, mineX: boolean, mineO: boolean): Omit<AchievementGame, keyof InviteBond> {
    if (!mineX && !mineO) throw new Error('an achievement game has no seat of the player');
    const { mode, game, difficulty, options, tuned } = readStored(row.doc);
    // A friend game holds this player on both seats.
    const you: Player | null = mineX && mineO ? null : mineX ? 'X' : 'O';
    const theirs = you === 'X' ? row.owner_o : you === 'O' ? row.owner_x : null;
    const opponent = (mode === 'online' || mode === 'nearby') && theirs !== core.COMPUTER_TOKEN ? theirs : null;
    // The metrics belong to the device that uploaded the result. In a computer game, that is the player.
    const metrics = mode === 'computer' && row.metrics !== null ? parseMetrics(row.metrics) : undefined;
    const input = metrics?.input ?? null;
    return { id: row.public_id, mode, game, you, difficulty, options, tuned, finishedAt: row.finished, opponent, input };
  }

  // Every invite event: a claimed tester code with an inviter, and a copy of the Android app with an inviter. The keys
  // name the human for peopleOf (server/invite-people.ts): the device token and the owner at the time of the event,
  // the account that holds the device now, and the email of a claim. So a claim on a
  // laptop and an app open on a phone count once when both devices log in to one account, also after the events. A claim from before the token columns has only its
  // email, or its code (given out by hand).
  // Limit: one Play purchase installs on every phone of that Google account, so two copies cannot tell two purchases
  // from one. The copies of one account count as one person: by the owner at the open, and by the account now.
  // Limit: it reads every invite, a few hundred rows at most now. Revisit this past 10,000 rows.
  // `tokens` are the token, the owner and the account of the invited person, without the email and the code.
  async function inviteEvents(): Promise<(InviteEvent & { invitedBy: PersonId; tokens: string[] })[]> {
    const found = await rows(
      `FROM tester_codes LEFT JOIN player_tokens linked ON linked.token = claimed_token
         SELECT invited_by, claimed_token AS token, claimed_owner AS owner,
           CASE WHEN linked.github_id IS NULL THEN NULL ELSE $account || lpad(linked.github_id::VARCHAR, 16, '0') END AS account,
           lower(email) AS email, code, epoch_ms(claimed_at) AS at
       WHERE invited_by IS NOT NULL AND claimed_at IS NOT NULL
       UNION ALL
       FROM app_copies LEFT JOIN player_tokens linked ON linked.token = app_copies.token
         SELECT invited_by, app_copies.token, owner,
           CASE WHEN linked.github_id IS NULL THEN NULL ELSE $account || lpad(linked.github_id::VARCHAR, 16, '0') END,
           NULL, NULL, epoch_ms(opened_at)
       WHERE invited_by IS NOT NULL`,
      { account: ACCOUNT_TOKEN_PREFIX },
      {
        invited_by: personColumn,
        token: nullable(text),
        owner: nullable(text),
        account: nullable(text),
        email: nullable(text),
        code: nullable(text),
        at: epoch,
      },
    );
    return found.map((row) => {
      const keys = [
        row.token === null ? [] : [`t:${row.token}`],
        row.owner === null ? [] : [`o:${row.owner}`],
        row.account === null ? [] : [`o:${row.account}`],
        row.email === null ? [] : [`e:${row.email}`],
      ].flat();
      if (keys.length === 0 && row.code === null) throw new Error('an invite event names nobody');
      const tokens = [row.token, row.owner, row.account].filter((token) => token !== null);
      return { invitedBy: row.invited_by, keys: keys.length === 0 ? [`c:${row.code ?? ''}`] : keys, at: row.at, tokens };
    });
  }
  type InviteRow = Awaited<ReturnType<typeof inviteEvents>>[number];

  // The person ids of a player: one for each of their tokens. An invite from a device before its login still
  // counts for the account, and an invite from the account counts on every device.
  const personsOfTokens = async (tokens: readonly string[]) => new Set(await Promise.all(tokens.map((token) => personId(token))));

  // The tokens of each owner (a canonical token): the owner itself, and the device tokens of an account.
  async function tokensOfOwners(owners: readonly string[]): Promise<Map<string, string[]>> {
    if (owners.length === 0) return new Map();
    const linked = await rows(
      `SELECT token, owner FROM (FROM player_tokens SELECT token, $account || lpad(github_id::VARCHAR, 16, '0') AS owner) WHERE list_contains($owners, owner)`,
      { owners: listValue([...owners]), account: ACCOUNT_TOKEN_PREFIX },
      { token: text, owner: text },
    );
    const byOwner = Map.groupBy(linked, (row) => row.owner);
    return new Map(owners.map((owner) => [owner, [owner, ...(byOwner.get(owner) ?? []).map((row) => row.token)]]));
  }

  const opponentsOf = (games: readonly { opponent: string | null }[]) => [...new Set(games.flatMap((game) => (game.opponent === null ? [] : [game.opponent])))];
  type InviteBond = Pick<AchievementGame, 'invitedOpponentAt' | 'invitedByOpponentAt'>;
  const NO_BOND: InviteBond = { invitedOpponentAt: null, invitedByOpponentAt: null };
  const firstAt = (events: readonly InviteRow[]): EpochMs | null =>
    events.reduce<EpochMs | null>((first, event) => (first === null || event.at < first ? event.at : first), null);

  // What the invites tell the rules about the player with these `tokens` (all of them, the owner too):
  // - invites: the people that the player invited, and the people that those people invited in turn, after the last
  //   "Reset achievements" (`since`). The events of one person count once (peopleOf). An invite of the player counts for nobody.
  // - bondOf: the first invite in each direction between the player and each opponent, at any time. `opponents` holds
  //   the tokens of each opponent (tokensOfOwners), by its canonical token. It reads no table, so it can run in parallel.
  // Limit: an invited person counts by token and account only. A claim from before the token columns (only an email)
  // links nobody to an opponent and brings no second invite. Revisit this if such players report a missing unlock.
  async function inviteFactsOf(
    events: readonly InviteRow[],
    tokens: readonly string[],
    opponents: ReadonlyMap<string, readonly string[]>,
    since: EpochMs | null,
  ): Promise<{ invites: Invites; bondOf: (opponent: string | null) => InviteBond }> {
    if (events.length === 0) return { invites: { direct: [], second: [] }, bondOf: () => NO_BOND };
    const mine = new Set(tokens);
    const persons = await personsOfTokens(tokens);
    const after = (at: EpochMs) => since === null || at > since;
    const sent = events.filter((event) => persons.has(event.invitedBy));
    const second: InviteEvent[] = [];
    for (const first of sent) {
      const theirs = await personsOfTokens(first.tokens);
      for (const next of events) {
        const self = next.tokens.some((token) => mine.has(token) || first.tokens.includes(token));
        // The second person got the game after the first one: that is when the chain is whole.
        const at = next.at > first.at ? next.at : first.at;
        if (theirs.has(next.invitedBy) && !self && after(at)) second.push({ keys: next.keys, at });
      }
    }
    const bonds = new Map(
      await Promise.all(
        [...opponents].map(async ([opponent, theirTokens]) => {
          const theirs = await personsOfTokens(theirTokens);
          const bond: InviteBond = {
            invitedOpponentAt: firstAt(sent.filter((event) => event.tokens.includes(opponent))),
            invitedByOpponentAt: firstAt(events.filter((event) => theirs.has(event.invitedBy) && event.tokens.some((token) => mine.has(token)))),
          };
          return [opponent, bond] as const;
        }),
      ),
    );
    return {
      invites: { direct: peopleOf(sent.filter((event) => after(event.at))), second: peopleOf(second) },
      bondOf: (opponent) => (opponent === null ? NO_BOND : (bonds.get(opponent) ?? NO_BOND)),
    };
  }

  // A new invite of the person `by` changes the invite achievements of `by`, and the Family tree of the people who invited `by`.
  async function inviteChanged(by: PersonId): Promise<void> {
    achievementCache.clear();
    const above: PersonId[] = [];
    for (const event of await inviteEvents()) if ((await personsOfTokens(event.tokens)).has(by)) above.push(event.invitedBy);
    for (const owner of await ownersOfPersons([by, ...above])) changedOwners.add(owner);
  }

  // The canonical tokens of the players behind these person ids: an account (by any of its tokens) or a device
  // without an account that held a seat (seat_people). A person without either has no row in achievement_players.
  async function ownersOfPersons(persons: readonly string[]): Promise<string[]> {
    if (persons.length === 0) return [];
    const found = await rows(
      `SELECT DISTINCT $account || lpad(github_id::VARCHAR, 16, '0') AS owner FROM player_tokens
       WHERE list_contains($persons, left(sha256($prefix || token), ${PERSON_ID_LENGTH}))
         OR list_contains($persons, left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), ${PERSON_ID_LENGTH}))
       UNION
       SELECT token AS owner FROM seat_people WHERE list_contains($persons, person) AND token NOT IN (FROM player_tokens SELECT token)`,
      { persons: listValue([...persons]), prefix: PERSON_ID_PREFIX, account: ACCOUNT_TOKEN_PREFIX },
      { owner: text },
    );
    return found.map((row) => row.owner);
  }

  // The achievements of the player `owner` (a canonical token) with these tokens, over every finished game
  // on all their devices since their last reset (see achievement_resets), and the invites of these tokens.
  async function progressOfTokens(owner: string, tokens: readonly string[]): Promise<AchievementProgress[]> {
    const key = tokens.toSorted().join(' ');
    const cached = achievementCache.get(key);
    if (cached !== undefined) return cached;
    const found = await rows(achievementRows(seatedResults(tokens.length)), { ...tokenValues(tokens), account: ACCOUNT_TOKEN_PREFIX }, ACHIEVEMENT_COLUMNS);
    const [reset] = await rows('FROM achievement_resets SELECT epoch_ms(reset_at) AS at WHERE owner = $owner', { owner }, { at: epoch });
    const own = new Set(tokens);
    const games = found
      .filter((row) => reset === undefined || row.finished > reset.at)
      .map((row) => achievementGame(row, row.token_x !== null && own.has(row.token_x), row.token_o !== null && own.has(row.token_o)));
    const events = await inviteEvents();
    const opponents = events.length === 0 ? new Map() : await tokensOfOwners(opponentsOf(games));
    const { invites, bondOf } = await inviteFactsOf(events, tokens, opponents, reset?.at ?? null);
    const progress = achievementProgress(
      games.map((game) => ({ ...game, ...bondOf(game.opponent) })),
      invites,
    );
    achievementCache.set(key, progress);
    return progress;
  }

  // The counted games of each player in `source` (owner: the canonical token of a seat), as in the rarity:
  // an account with its devices, or a device without an account. A Nearby guest counts the host's copy.
  // `counts` is false for a game before the player's last "Reset achievements": such a player still counts as a player.
  // Bound values: $account and $computer, and those of `source`.
  const ownedGames = (source: string) => `seats AS (
      SELECT results.id, results.finished_at, unnest([results.player_x, results.player_o]) AS token FROM ${source} results WHERE NOT ${HOST_HAS_GAME}),
    owned AS (
      SELECT DISTINCT seats.id, seats.finished_at, coalesce($account || lpad(pt.github_id::VARCHAR, 16, '0'), seats.token) AS owner
      FROM seats LEFT JOIN player_tokens pt USING (token) WHERE seats.token IS NOT NULL AND seats.token <> $computer),
    counted AS (
      SELECT owned.*, r.reset_at IS NULL OR owned.finished_at > r.reset_at AS counts FROM owned LEFT JOIN achievement_resets r USING (owner))`;
  // The games behind a row of achievement_players. A new or removed achievement changes it too ($rules).
  const SIGNATURE = `md5($rules) || ':' || count(*) FILTER (counts) || ':' || coalesce(bit_xor(hash(id)) FILTER (counts), 0)`;
  const ownerOfSeat = (seat: string, joined: string) => `coalesce($account || lpad(${joined}.github_id::VARCHAR, 16, '0'), ${seat})`;
  const ownerValues = () => ({ account: ACCOUNT_TOKEN_PREFIX, computer: core.COMPUTER_TOKEN });
  const rulesValue = () => `${ACHIEVEMENT_RULES_VERSION} ${ACHIEVEMENT_IDS.join(' ')}`;

  // Fills the rows of these owners again from their games, through the seat indexes. An owner without
  // games (a device that joined an account) loses its row.
  async function refreshOwners(owners: readonly string[]): Promise<void> {
    const tokensOf = await tokensOfOwners(owners);
    const tokens = [...new Set([...tokensOf.values()].flat())];
    // A device that joined an account counts as the account, so it keeps no row of its own, also with invites.
    const joined = new Set(
      (
        await rows(
          `FROM player_tokens SELECT token WHERE list_contains($owners, token) AND token <> $account || lpad(github_id::VARCHAR, 16, '0')`,
          { owners: listValue([...owners]), account: ACCOUNT_TOKEN_PREFIX },
          { token: text },
        )
      ).map((row) => row.token),
    );
    const source = seatedResults(tokens.length);
    const values = { ...ownerValues(), ...tokenValues(tokens), owners: listValue([...owners]) };
    const signatures = await rows(
      `WITH ${ownedGames(source)} SELECT owner, ${SIGNATURE} AS signature FROM counted WHERE list_contains($owners, owner) GROUP BY owner`,
      { ...values, rules: rulesValue() },
      { owner: text, signature: text },
    );
    const found = await rows(
      `WITH ${ownedGames(source)}
      SELECT counted.owner, results.public_id, results.doc::JSON AS doc, results.metrics::JSON AS metrics, epoch_ms(results.finished_at) AS finished,
        ${ownerOfSeat('results.player_x', 'px')} AS owner_x, ${ownerOfSeat('results.player_o', 'po')} AS owner_o
      FROM counted JOIN ${source} results USING (id)
        LEFT JOIN player_tokens px ON px.token = results.player_x LEFT JOIN player_tokens po ON po.token = results.player_o
      WHERE counted.counts AND list_contains($owners, counted.owner)`,
      values,
      { owner: text, public_id: nullable(gameId), doc: json, metrics: nullable(json), finished: epoch, owner_x: nullable(text), owner_o: nullable(text) },
    );
    const games = Map.groupBy(found, (row) => row.owner);
    // The invites, as in progressOfTokens. Most refreshes find no invited claim, and then hash no token.
    const claims = await inviteEvents();
    const resets =
      claims.length === 0
        ? new Map<string, EpochMs>()
        : new Map(
            (await rows('FROM achievement_resets SELECT owner, epoch_ms(reset_at) AS at WHERE list_contains($owners, owner)', { owners: listValue([...owners]) }, { owner: text, at: epoch })).map(
              (row) => [row.owner, row.at],
            ),
          );
    const signatureOf = new Map(signatures.map((row) => [row.owner, row.signature]));
    // A player with games, or an inviter without games (INVITES_ONLY), so the rarity counts every holder of an invite achievement.
    const playedOf = new Map(owners.map((owner) => [owner, (games.get(owner) ?? []).map((row) => achievementGame(row, row.owner_x === owner, row.owner_o === owner))]));
    const opponents = claims.length === 0 ? new Map() : await tokensOfOwners(opponentsOf([...playedOf.values()].flat()));
    const filled = await Promise.all(
      owners.map(async (owner) => {
        if (joined.has(owner)) return [];
        const played = playedOf.get(owner) ?? [];
        const { invites, bondOf } = await inviteFactsOf(claims, tokensOf.get(owner) ?? [owner], opponents, resets.get(owner) ?? null);
        const signature = signatureOf.get(owner) ?? (invites.direct.length > 0 || invites.second.length > 0 ? INVITES_ONLY : undefined);
        if (signature === undefined) return [];
        const unlocked = achievementProgress(
          played.map((game) => ({ ...game, ...bondOf(game.opponent) })),
          invites,
        )
          .filter((entry) => entry.unlockedAt !== null)
          .toSorted((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0))
          .map((entry) => entry.id);
        return [{ owner, signature, unlocked }];
      }),
    );
    const written = filled.flat();
    await db.run('DELETE FROM achievement_players WHERE list_contains($owners, owner)', { owners: listValue([...owners]) });
    if (written.length > 0) {
      await db.run(
        `INSERT INTO achievement_players (owner, signature, unlocked)
         SELECT unnest($owners::VARCHAR[]), unnest($signatures::VARCHAR[]), unnest($unlocked::JSON::VARCHAR[][])`,
        {
          owners: listValue(written.map((row) => row.owner)),
          signatures: listValue(written.map((row) => row.signature)),
          // As JSON text: a list value cannot hold an empty list without a type.
          unlocked: JSON.stringify(written.map((row) => row.unlocked)),
        },
      );
    }
    rarityCache = undefined;
  }

  // Brings achievement_players up to date for the changed owners. It runs on the store queue.
  async function refreshAchievements(): Promise<void> {
    const owners = [...changedOwners];
    changedOwners.clear();
    for (let start = 0; start < owners.length; start += ACHIEVEMENT_BATCH) await refreshOwners(owners.slice(start, start + ACHIEVEMENT_BATCH));
  }

  // Compares every player with achievement_players in the background, at the start and after a deletion
  // (which can change the games of other players: a Nearby guest counts again without the host's copy).
  // The reads run on the reader; the store queue then drops the rows of players without games and marks the changed ones.
  // Limit: it reads every result, about 10 s at 5,000,000 results, outside the store queue.
  function checkAllAchievements(): void {
    inBackground(async () => {
      const changed = await readRows(
        `WITH ${ownedGames('results')}, current AS (SELECT owner, ${SIGNATURE} AS signature FROM counted GROUP BY owner)
        SELECT owner FROM current LEFT JOIN achievement_players p USING (owner) WHERE p.signature IS DISTINCT FROM current.signature`,
        { ...ownerValues(), rules: rulesValue() },
        { owner: text },
      );
      const gone = await readRows(`FROM achievement_players SELECT owner WHERE owner NOT IN (WITH ${ownedGames('results')} SELECT owner FROM owned)`, ownerValues(), {
        owner: text,
      });
      await serialized(async () => {
        if (gone.length > 0) await db.run('DELETE FROM achievement_players WHERE list_contains($owners, owner)', { owners: listValue(gone.map((row) => row.owner)) });
        for (const { owner } of changed) changedOwners.add(owner);
        // A signature names games, not invites, so every inviter that the server can find gets a fresh row. That also
        // brings back an inviter without games, whose row went with `gone`. Inviters are few.
        const invited = [...new Set((await inviteEvents()).map((event) => event.invitedBy))];
        for (const owner of await ownersOfPersons(invited)) changedOwners.add(owner);
        rarityCache = undefined;
      });
    }).catch((error: unknown) => console.error('achievement check:', error instanceof Error ? error.message : String(error)));
  }

  // How many players unlocked each achievement, out of every player with a finished game.
  async function everyonesRarity(): Promise<AchievementRarity> {
    await refreshAchievements();
    if (rarityCache !== undefined) return rarityCache;
    const [total] = await rows('SELECT count(*)::INTEGER AS n FROM achievement_players', {}, { n: int });
    const counts = await rows(
      'SELECT id, count(*)::INTEGER AS n FROM (SELECT unnest(unlocked) AS id FROM achievement_players) GROUP BY id',
      {},
      { id: oneOf(ACHIEVEMENT_IDS), n: int },
    );
    const byId = new Map(counts.map((row) => [row.id, row.n]));
    const unlocked = Object.fromEntries(ACHIEVEMENT_IDS.map((id) => [id, byId.get(id) ?? 0])) as Record<AchievementId, number>;
    rarityCache = { players: total?.n ?? 0, unlocked };
    return rarityCache;
  }

  // Whether the player of this browser holds a copy: this device holds one, or another device that is logged in to the
  // same account. So a copy follows the account that logged in last on that device, and a logout takes it back.
  // Takes the device slot of an iPhone app purchase for this player token, in one transaction. A device keeps its slot
  // on later opens. A new token on the same device (cleared app data) takes the slot over, and the old token loses its
  // proof: a copied proof and device id can only take turns with the real phone, never add a slot. A new device gets a
  // slot while the purchase holds fewer than APPLE_SLOTS_PER_PURCHASE; a slot unused for APPLE_SLOT_IDLE_DAYS frees
  // itself first, so a lost phone does not keep its slot. 409 when the device holds another purchase, 403 when full.
  async function takeAppleSlot(token: PlayerToken, { environment, appTransactionId, device }: ApplePurchase): Promise<void> {
    const purchase = `${environment}:${appTransactionId}`;
    await db.run('BEGIN TRANSACTION');
    try {
      const [slot] = await rows('FROM apple_slots SELECT purchase, token WHERE device = $device', { device }, { purchase: text, token: text });
      if (slot !== undefined && slot.purchase !== purchase) throw new SessionError(409, 'This device holds another Apple purchase.');
      if (slot === undefined) {
        await db.run(`DELETE FROM apple_slots WHERE purchase = $purchase AND last_seen_at < now() - INTERVAL ${APPLE_SLOT_IDLE_DAYS} DAY`, { purchase });
        const [used] = await rows('FROM apple_slots SELECT count(*)::INTEGER AS n WHERE purchase = $purchase AND token <> $token', { purchase, token }, { n: int });
        if ((used?.n ?? 0) >= APPLE_SLOTS_PER_PURCHASE) {
          throw new SessionError(403, `This Apple purchase holds ${APPLE_SLOTS_PER_PURCHASE} devices already. A device unused for ${APPLE_SLOT_IDLE_DAYS} days frees its place.`);
        }
      }
      if (slot !== undefined && slot.token !== token) await db.run('UPDATE app_copies SET proved = false WHERE token = $old', { old: slot.token });
      // A token lives on one device: its slot under another device id goes.
      await db.run('DELETE FROM apple_slots WHERE token = $token OR device = $device', { token, device });
      await db.run('INSERT INTO apple_slots (device, purchase, token) VALUES ($device, $purchase, $token)', { device, purchase, token });
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  }

  async function hasCopyOf(token: PlayerToken): Promise<boolean> {
    const [copy] = await rows(
      `FROM app_copies SELECT token
       WHERE token = $token OR token IN (FROM player_tokens SELECT token WHERE github_id = (FROM player_tokens SELECT github_id WHERE token = $token))
       LIMIT 1`,
      { token },
      { token: text },
    );
    return copy !== undefined;
  }

  async function achievementsOf(owner: string, tokens: readonly string[]): Promise<Achievements> {
    const achievements = await progressOfTokens(owner, tokens);
    // An inviter without games and without a seat is unknown to ownersOfPersons, so it gets its row here, before
    // the rarity: an unlocked achievement never shows "0% of players".
    if (achievements.some((entry) => entry.unlockedAt !== null)) {
      const [known] = await rows('FROM achievement_players SELECT owner WHERE owner = $owner', { owner }, { owner: text });
      if (known === undefined) changedOwners.add(owner);
    }
    return { achievements, rarity: await everyonesRarity() };
  }

  type NewResult = {
    id: string;
    token: string;
    doc: object;
    finishedAt: EpochMs;
    publicId: GameId;
    seats: Record<Player, string | null>;
    game: GameRecord;
    metrics: Metrics | null;
  };

  // Stores a finished game. Returns false when a row with this id exists already.
  // Throws a duplicate key error when another row holds the public id.
  async function insertResult(result: NewResult): Promise<boolean> {
    const { winner, ending, line } = endingOf(result.game);
    const inserted = await rows(
      `INSERT INTO results (id, token, doc, finished_at, public_id, player_x, player_o, winner, ending, line, metrics, ${GAME_COLUMN_LIST}, ${METRIC_COLUMN_LIST})
       VALUES ($id, $token, $doc::JSON::VARIANT, make_timestamptz($finished * 1000), $publicId, $x, $o, $winner, $ending, $line, $metrics::JSON::VARIANT, ${GAME_VALUES}, ${METRIC_VALUES})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      {
        id: result.id,
        token: result.token,
        doc: JSON.stringify(result.doc),
        finished: result.finishedAt,
        publicId: result.publicId,
        x: result.seats.X,
        o: result.seats.O,
        winner,
        ending,
        line,
        metrics: result.metrics === null ? null : JSON.stringify(result.metrics),
      },
      { id: text },
    );
    achievementCache.clear();
    const seats = [result.seats.X, result.seats.O].filter((seat): seat is string => seat !== null && seat !== core.COMPUTER_TOKEN);
    for (const seat of seats) await db.run('INSERT OR IGNORE INTO seat_people (person, token) VALUES ($person, $token)', { person: await personId(seat), token: seat });
    for (const owner of (await canonical(seats)).values()) changedOwners.add(owner);
    return inserted.length > 0;
  }

  // Records a finished game of an online session in `results`, so every mode has rows in one table.
  // A second call for the same game changes nothing.
  async function recordOnline(code: Code, doc: SessionDoc, index: number, finishedAt: EpochMs): Promise<void> {
    const game = doc.games[index];
    if (game === undefined || !isFinished(game)) throw new Error(`game ${index} of ${code} is not finished`);
    const token = doc.seats.X ?? doc.seats.O;
    if (token === null) throw new Error(`a finished game in ${code} without players`);
    await insertResult({
      // ':' is not a character of an uploaded result id, so the two kinds never meet.
      id: `online:${code}:${index}`,
      token,
      doc: { mode: 'online', code, number: index + 1, name: doc.name, game, options: doc.options, finishedAt },
      finishedAt,
      publicId: onlineGameId(code, index),
      seats: doc.seats,
      game,
      metrics: null,
    });
  }

  async function save(row: Row, doc: SessionDoc): Promise<Row> {
    const text = serialize(doc);
    await db.run(
      `UPDATE sessions SET doc = $doc::JSON::VARIANT, ${SESSION_SEAT_SET}, version = version + 1, updated_at = now() WHERE code = $code`,
      { code: row.code, doc: text },
    );
    // The row as a read would find it now, without the read.
    const saved = keepRow(rowOf(row.code, JSON.parse(text), row.version + 1));
    // Only the live game can end, by a move or by a timeout.
    const index = doc.games.length - 1;
    const live = doc.games[index];
    const before = row.doc.games[index];
    if (doc.mode === 'online' && live !== undefined && isFinished(live) && !(before !== undefined && isFinished(before))) {
      await recordOnline(row.code, doc, index, live.timedOut ? now() : (live.times.at(-1) ?? now()));
    }
    onChange(row.code);
    return saved;
  }

  // Loads a session, records a timeout that happened since the last write, and writes a document
  // in an older format back in the current format.
  async function load(code: Code): Promise<Row> {
    const row = await loadRaw(code);
    const settled = core.settle(row.doc, now());
    if (settled !== undefined) return save(row, settled);
    return row.stale ? save(row, row.doc) : row;
  }

  // The provider, subject id and label of a login (see logins).
  const loginKey = (user: LoginUser) =>
    'google' in user
      ? { provider: 'google' as const, subject: user.google, label: null }
      : { provider: 'github' as const, subject: String(user.id), label: user.login };

  // True when `name` is the GitHub login of an account other than `account` (GitHub logins ignore case).
  async function isGitHubLoginOfOther(name: string, account: bigint | null): Promise<boolean> {
    const [clash] = await rows(
      "FROM logins SELECT label WHERE provider = 'github' AND lower(label) = lower($name) AND github_id IS DISTINCT FROM $account",
      { name, account },
      { label: text },
    );
    return clash !== undefined;
  }

  // The account of a login, or undefined when the login has none yet.
  async function knownAccountOf(user: LoginUser): Promise<bigint | undefined> {
    const { provider, subject } = loginKey(user);
    const [found] = await rows('FROM logins SELECT github_id WHERE provider = $provider AND subject = $subject', { provider, subject }, { github_id: bigId });
    return found?.github_id;
  }

  // The account of a login. A login without an account makes one: a GitHub login with its GitHub id, a
  // Google login with a new negative id. The login that made the account gives it its name and picture,
  // and refreshes them: a GitHub login on every request, a Google login at each sign-in. A connected
  // login of the other provider leaves them.
  async function accountOfLogin(user: LoginUser): Promise<bigint> {
    const { provider, subject, label } = loginKey(user);
    let id = await knownAccountOf(user);
    if (id === undefined) {
      const [next] = 'google' in user ? await rows("SELECT -nextval('account_ids') AS id", {}, { id: bigId }) : [{ id: BigInt(user.id) }];
      if (next === undefined) throw new Error('the account id sequence answered nothing');
      id = next.id;
      await db.run('INSERT INTO logins (provider, subject, github_id, label) VALUES ($provider, $subject, $id, $label)', { provider, subject, id, label });
    } else if (label !== null) {
      await db.run('UPDATE logins SET label = $label WHERE provider = $provider AND subject = $subject', { provider, subject, label });
    }
    // A Google cookie has no profile. Its account keeps the name and photo of the last sign-in, or gets
    // a generated name when it has no users row: an account deleted on another device while this cookie lived.
    // A Google name that is the GitHub login of another account would pose as that player: it gets a generated name.
    const googleName = 'profile' in user && user.profile.name !== null && !(await isGitHubLoginOfOther(user.profile.name, id)) ? user.profile.name : null;
    const profile =
      'profile' in user
        ? { login: googleName ?? nameOf(accountToken(id)), avatar: user.profile.picture }
        : 'google' in user
          ? undefined
          : { login: user.login, avatar: user.avatar };
    await db.run('INSERT INTO users (github_id, provider, login, avatar) VALUES ($id, $provider, $login, $avatar) ON CONFLICT DO NOTHING', {
      id,
      provider,
      login: profile?.login ?? nameOf(accountToken(id)),
      avatar: profile?.avatar ?? null,
    });
    if (profile !== undefined) {
      await db.run('UPDATE users SET login = $login, avatar = $avatar WHERE github_id = $id AND provider = $provider', { id, provider, ...profile });
    }
    await db.run('UPDATE users SET seen_at = now() WHERE github_id = $id', { id });
    return id;
  }

  // Moves the account `from` into the account `into`, in one transaction. `into` keeps its name, picture and
  // custom name. The devices of `from` and its account token point to `into`, so its seats, games, stats,
  // records and practice runs follow through player_tokens (canonical). The rows that name the account token
  // of `from` as their owner move: blocks, Hide my stats, the achievement reset, app copies and tester claims.
  // A block by another player of `from` moves to `into`, so it keeps working. A report keeps the person id of its time.
  // Limit: a chat message from before the merge names the old person id, so it shows again to a player who blocked `from`.
  // Revisit this when a player reports such a message.
  async function mergeAccounts(into: bigint, from: bigint): Promise<void> {
    const [conflict] = await rows(
      'FROM logins a JOIN logins b USING (provider) SELECT provider WHERE a.github_id = $into AND b.github_id = $from',
      { into, from },
      { provider: oneOf(LOGIN_PROVIDERS) },
    );
    if (conflict !== undefined) throw new SessionError(409, `Both accounts have a ${PROVIDER_NAMES[conflict.provider]} login, so they cannot become one.`);
    const intoToken = accountToken(into);
    const fromToken = accountToken(from);
    const owners = { into: intoToken, from: fromToken };
    const source = { from: fromToken };
    await db.run('BEGIN TRANSACTION');
    try {
      await db.run('UPDATE logins SET github_id = $into WHERE github_id = $from', { into, from });
      await db.run('UPDATE player_tokens SET github_id = $into WHERE github_id = $from', { into, from });
      await db.run('DELETE FROM users WHERE github_id = $from', { from });
      // A block of either account stays, once.
      await db.run('INSERT INTO blocks SELECT * REPLACE ($into AS owner) FROM blocks WHERE owner = $from ON CONFLICT DO NOTHING', owners);
      await db.run('DELETE FROM blocks WHERE owner = $from', source);
      // Hidden stats stay hidden when either account hid them.
      await db.run('INSERT INTO private_stats SELECT * REPLACE ($into AS owner) FROM private_stats WHERE owner = $from ON CONFLICT DO NOTHING', owners);
      await db.run('DELETE FROM private_stats WHERE owner = $from', source);
      // The later reset wins, so no game counts that a reset of either account dropped.
      await db.run(
        `INSERT INTO achievement_resets SELECT * REPLACE ($into AS owner) FROM achievement_resets WHERE owner = $from
         ON CONFLICT (owner) DO UPDATE SET reset_at = greatest(achievement_resets.reset_at, excluded.reset_at)`,
        owners,
      );
      await db.run('DELETE FROM achievement_resets WHERE owner = $from', source);
      await db.run('DELETE FROM achievement_players WHERE owner = $from', source);
      await db.run('UPDATE app_copies SET owner = $into WHERE owner = $from', owners);
      await db.run('UPDATE tester_codes SET claimed_owner = $into WHERE claimed_owner = $from', owners);
      const persons = { into: await personId(intoToken), from: await personId(fromToken) };
      await db.run('INSERT INTO blocks SELECT * REPLACE ($into AS person) FROM blocks WHERE person = $from ON CONFLICT DO NOTHING', persons);
      await db.run('DELETE FROM blocks WHERE person = $from', { from: persons.from });
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    changedOwners.add(intoToken);
    changedOwners.add(fromToken);
    achievementCache.clear();
  }

  // Adds the player_tokens row of an account token, for an account that linked before account seats.
  async function ensureAccountRow(githubId: number | bigint): Promise<string> {
    const account = accountToken(githubId);
    // A lookup first: the insert is a write, and each write empties the account cache.
    const [known] = await accountRows('FROM player_tokens SELECT github_id WHERE token = $token', { token: account }, { github_id: bigId });
    if (known !== undefined) return account;
    await db.run('INSERT INTO player_tokens (token, github_id) VALUES ($token, $id) ON CONFLICT (token) DO NOTHING', {
      token: account,
      id: githubId,
    });
    return account;
  }

  // The token that a new seat of this device holds: the account token when the device is logged in.
  async function seatTokenOf(token: PlayerToken): Promise<string> {
    const [linked] = await accountRows('FROM player_tokens SELECT github_id WHERE token = $token', { token }, { github_id: bigId });
    return linked === undefined ? token : ensureAccountRow(linked.github_id);
  }

  // The token plus the tokens of the same GitHub account (the account token among them), so a
  // logged-in player holds their seats on every device.
  async function identityOf(token: PlayerToken | undefined): Promise<core.Identity> {
    if (token === undefined) return new Set();
    const linked = await accountRows(
      `FROM player_tokens SELECT token, github_id
       WHERE github_id = (FROM player_tokens SELECT github_id WHERE token = $token)`,
      { token },
      { token: text, github_id: bigId },
    );
    // The account token counts also before its own row exists (an account that linked before account seats).
    const account = linked[0] === undefined ? [] : [accountToken(linked[0].github_id)];
    return new Set([token, ...account, ...linked.map((row) => row.token)]);
  }

  // The GitHub account of each token, in one query. A token without an account, or null, has none.
  async function accountsOf(tokens: readonly (string | null)[]): Promise<(token: string | null) => PlayerInfo | null> {
    const known = [...new Set(tokens.filter((token) => token !== null))];
    if (known.length === 0) return () => null;
    const found = await accountRows(
      `FROM player_tokens JOIN users USING (github_id) SELECT token, ${ACCOUNT_COLUMN_LIST}
       WHERE list_contains($tokens, token)`,
      { tokens: listValue(known) },
      { token: text, ...ACCOUNT_COLUMNS },
    );
    return (token) => {
      const match = found.find((row) => row.token === token);
      return match === undefined ? null : accountOf(match);
    };
  }

  async function playersOf(doc: SessionDoc): Promise<Record<Player, PlayerInfo | null>> {
    const info = await accountsOf([doc.seats.X, doc.seats.O]);
    return { X: info(doc.seats.X), O: info(doc.seats.O) };
  }

  // The token that stands for a person: the account token of a linked device, else the token itself.
  // Blocks and person ids use it, so they follow a logged-in account across devices.
  async function canonical(tokens: readonly string[]): Promise<Map<string, string>> {
    const known = [...new Set(tokens)];
    const linked =
      known.length === 0
        ? []
        : await accountRows('FROM player_tokens SELECT token, github_id WHERE list_contains($tokens, token)', { tokens: listValue(known) }, { token: text, github_id: bigId });
    const accounts = new Map(linked.map((row) => [row.token, accountToken(row.github_id)]));
    return new Map(known.map((token) => [token, accounts.get(token) ?? token]));
  }

  // The public person id of each token (personId in src/protocol.ts), through its canonical token.
  async function personsOf(tokens: readonly (string | null)[]): Promise<(token: string) => PersonId | null> {
    const known = tokens.filter((token): token is string => token !== null && token !== core.COMPUTER_TOKEN);
    const canon = await canonical(known);
    const ids = new Map(await Promise.all([...canon].map(async ([token, owner]) => [token, await personId(owner)] as const)));
    return (token) => ids.get(token) ?? null;
  }

  // The canonical token of the caller, for the blocks table.
  async function ownerOf(token: PlayerToken): Promise<string> {
    return (await canonical([token])).get(token) ?? token;
  }

  // The person behind a public person id: their canonical token, their tokens for the stats, and the
  // name and GitHub account that their games show. undefined when no account and no finished game has the id.
  // An account: DuckDB's sha256 over the accounts finds it, as in clearPersonName. A device: seat_people.
  async function statsPersonOf(person: PersonId): Promise<{ owner: string; tokens: string[]; shown: Omit<StatsPerson, 'you'> } | undefined> {
    const [account] = await rows(
      `FROM (SELECT DISTINCT github_id FROM player_tokens) LEFT JOIN users USING (github_id) SELECT github_id, ${ACCOUNT_COLUMN_LIST}
       WHERE left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), ${PERSON_ID_LENGTH}) = $person`,
      { prefix: PERSON_ID_PREFIX, account: ACCOUNT_TOKEN_PREFIX, person },
      { github_id: bigId, ...ACCOUNT_COLUMNS },
    );
    if (account !== undefined) {
      const owner = accountToken(account.github_id);
      const linked = await rows('FROM player_tokens SELECT token WHERE github_id = $id', { id: account.github_id }, { token: text });
      const player = accountOf(account);
      const name = accountNameOf(player) ?? (await namesOf([owner]))(owner);
      return { owner, tokens: [owner, ...linked.map((row) => row.token)], shown: { name, player } };
    }
    // A device without an account. A linked token stands for its account, so it is not a device person.
    // The token still holds a seat: a logout moves the games of a device to its account.
    const [device] = await rows(
      `FROM seat_people p SELECT p.token
       WHERE p.person = $person AND p.token NOT IN (FROM player_tokens SELECT token)
         AND (EXISTS (FROM results WHERE player_x = p.token) OR EXISTS (FROM results WHERE player_o = p.token))`,
      { person },
      { token: text },
    );
    if (device === undefined) return undefined;
    return { owner: device.token, tokens: [device.token], shown: { name: (await namesOf([device.token]))(device.token), player: null } };
  }

  // The person of a person view, for the caller `token`: 403 when the person hides their stats from the caller,
  // 404 without an account and a finished game. It runs on the store queue.
  async function visiblePersonOf(person: PersonId, token: PlayerToken | null): Promise<{ owner: string; tokens: string[]; person: StatsPerson }> {
    const hidden = await privateOwnerOf(person);
    const caller = token === null ? null : await ownerOf(token);
    if (hidden !== undefined && caller !== hidden) throw new SessionError(403, STATS_PRIVATE_MESSAGE);
    const found = await statsPersonOf(person);
    if (found === undefined) throw new SessionError(404, 'This player has no finished games yet.');
    return { owner: found.owner, tokens: found.tokens, person: { ...found.shown, you: caller === found.owner } };
  }

  async function isStatsPrivate(owner: string): Promise<boolean> {
    return (await rows('FROM private_stats SELECT owner WHERE owner = $owner', { owner }, { owner: text })).length > 0;
  }

  // The owner behind a person id who hides their stats, or undefined. It needs no game, so a 403 does
  // not tell whether the person has games.
  async function privateOwnerOf(person: PersonId): Promise<string | undefined> {
    const [found] = await rows(
      `FROM private_stats SELECT owner WHERE left(sha256($prefix || owner), ${PERSON_ID_LENGTH}) = $person`,
      { prefix: PERSON_ID_PREFIX, person },
      { owner: text },
    );
    return found?.owner;
  }

  async function logModeration(login: string, action: ModerationAction['action'], target: { code?: Code; message?: number; person?: PersonId }): Promise<void> {
    await db.run('INSERT INTO moderation_log (login, action, code, message, person) VALUES ($login, $action, $code, $message, $person)', {
      login,
      action,
      code: target.code ?? null,
      message: target.message ?? null,
      person: target.person ?? null,
    });
  }

  // The display name of each token: the custom name (player_names), else the generated name.
  // A GitHub account (its custom name, else its login) goes before both, through `players` or `player` in the view.
  async function namesOf(tokens: readonly (string | null)[]): Promise<core.NameOf> {
    const known = [...new Set(tokens.filter((token): token is string => token !== null && token !== core.COMPUTER_TOKEN))];
    const found =
      known.length === 0
        ? []
        : await accountRows('FROM player_names SELECT token, name WHERE list_contains($tokens, token)', { tokens: listValue(known) }, { token: text, name: text });
    const custom = new Map(found.map((row) => [row.token, row.name]));
    return (token) => custom.get(token) ?? nameOf(token);
  }

  // Who has the session open: the present seats, and the watchers. A token whose account holds a
  // seat on another device counts for that seat. Two devices of one account watch as one watcher.
  async function audience(code: Code, doc: SessionDoc): Promise<core.Audience> {
    const tokens = [...new Set(open(code))];
    const linked =
      tokens.length === 0
        ? []
        : await accountRows(
            `FROM player_tokens a JOIN player_tokens b USING (github_id) JOIN users u USING (github_id)
             SELECT a.token AS token, b.token AS linked, u.github_id, u.provider, u.login, u.avatar, u.name, u.seed WHERE list_contains($tokens, a.token)`,
            { tokens: listValue(tokens) },
            { token: text, linked: text, github_id: bigId, ...ACCOUNT_COLUMNS },
          );
    const presence = { X: false, O: false };
    const watchers: core.OpenWatcher[] = [];
    // One watcher per account: two Google players can have the same name, so the account id tells them apart.
    const accounts = new Set<bigint>();
    for (const token of tokens) {
      const own = linked.filter((row) => row.token === token);
      const seats = core.seatsOf(doc, new Set([token, ...own.map((row) => row.linked)]));
      for (const seat of seats) presence[seat] = true;
      if (seats.length > 0) continue;
      const account = own[0];
      const player = account === undefined ? null : accountOf(account);
      if (account !== undefined && accounts.has(account.github_id)) continue;
      if (account !== undefined) accounts.add(account.github_id);
      // A logged-in watcher takes a seat for the account, like a join. The id stays from the device token.
      watchers.push({ id: watcherId(code, token), token: account === undefined ? token : accountToken(account.github_id), player });
    }
    const everyone = [doc.seats.X, doc.seats.O, doc.seatRequest?.watcher ?? null, ...watchers.map((watcher) => watcher.token)];
    return { presence, watchers, name: await namesOf(everyone), person: await personsOf(everyone) };
  }

  async function view(row: Row, identity: core.Identity): Promise<SessionView> {
    return core.viewOf(row.doc, {
      code: row.code,
      version: row.version,
      identity,
      now: now(),
      audience: await audience(row.code, row.doc),
      players: await playersOf(row.doc),
    });
  }

  type Rule = (doc: SessionDoc, identity: core.Identity, watchers: readonly core.OpenWatcher[]) => SessionDoc;

  // Loads, applies one rule of the core, saves when it changed something, and returns the caller's view.
  function change(code: Code, token: PlayerToken, rule: Rule) {
    return serialized(async () => {
      const row = await load(code);
      const identity = await identityOf(token);
      const { watchers } = await audience(code, row.doc);
      // A rule can seat a logged-in watcher by its account token, so its row must exist first.
      for (const watcher of watchers) {
        if (watcher.token.startsWith(ACCOUNT_TOKEN_PREFIX)) await ensureAccountRow(accountIdOf(watcher.token));
      }
      const doc = rule(row.doc, identity, watchers);
      return view(doc === row.doc ? row : await save(row, doc), identity);
    });
  }

  // The finished game of an online id ("<CODE>-<n>") in its session, or a 404.
  async function finishedOnlineGame(id: GameId): Promise<{ row: Row; game: GameRecord; index: number }> {
    const notFound = new SessionError(404, 'No game with this link.');
    if (!isOnlineGameId(id)) throw notFound;
    const { code, index } = onlineGameParts(id);
    let row: Row;
    try {
      row = await loadRaw(code);
    } catch (error) {
      if (error instanceof SessionError) throw notFound;
      throw error;
    }
    const game = row.doc.games[index];
    if (game === undefined || !isFinished(game)) throw notFound;
    return { row, game, index };
  }

  // An online game that ended before the server recorded games in `results` reads from its session.
  // The hide options are those of the session now: the session does not keep them per game.
  async function onlineGameFromSession(id: GameId): Promise<PublicGame> {
    const { row, game, index } = await finishedOnlineGame(id);
    // The players of that game, by the seat that each one held in it.
    const holder = (seat: Player) => seatIn(row.doc.flipped, index, seat);
    const players = await playersOf(row.doc);
    return parsePublicGame({
      id,
      mode: 'online',
      game,
      options: row.doc.options,
      difficulty: null,
      tuned: false,
      computer: null,
      players: { X: players[holder('X')], O: players[holder('O')] },
      names: await seatNames(row.doc.seats[holder('X')], row.doc.seats[holder('O')]),
      finishedAt: game.times.at(-1) ?? now(),
    });
  }

  async function seatNames(x: string | null, o: string | null): Promise<Record<Player, string | null>> {
    const name = await namesOf([x, o]);
    return { X: core.seatName(x, name), O: core.seatName(o, name) };
  }

  // The last answer of each Everyone query, by kind and filter (statsQuery). The filters have a few dozen
  // combinations, so the map stays small. A request gets the last answer at once. An answer older than its
  // time to live starts a refresh in the background, and the next request gets the new answer. The time to
  // live grows with the cost of a refresh, so a slow refresh does not keep the reader busy.
  // Only the first request of a filter after a start waits for the answer.
  const snapshots = new Map<string, { value: unknown; at: EpochMs; ttl: number }>();
  const refreshing = new Map<string, Promise<unknown>>();
  function snapshot<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const refresh = (): Promise<T> => {
      const running = refreshing.get(key);
      if (running !== undefined) return running as Promise<T>;
      const started = inBackground(async () => {
        const began = now();
        const value = await compute();
        snapshots.set(key, { value, at: now(), ttl: Math.max(STATS_CACHE_MS, SNAPSHOT_COST_FACTOR * (now() - began)) });
        return value;
      }).finally(() => refreshing.delete(key));
      refreshing.set(key, started);
      return started;
    };
    const known = snapshots.get(key);
    if (known === undefined) return refresh();
    if (now() - known.at >= known.ttl) {
      refresh().catch((error: unknown) => console.error(`snapshot ${key}:`, error instanceof Error ? error.message : String(error)));
    }
    return Promise.resolve(known.value as T);
  }

  // The leaderboard of a range, mode and level, without the caller. The unlocks come first (a write, so on the
  // store queue), then the board on the reader, then the names on the store queue.
  async function leaderboardOf(filter: StatsFilter): Promise<Omit<Leaderboard, 'you'>> {
    await serialized(refreshAchievements);
    const found = await leaderRows(readRows, filter, now());
    const names = await serialized(() => namesOf(found.map((row) => row.owner)));
    return {
      generatedAt: now(),
      rows: await Promise.all(
        found.map(async (row) => ({
          person: await personId(row.owner),
          name: row.name ?? row.login ?? names(row.owner),
          player: accountOf(row),
          games: row.games,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          fastestWin: row.fastest_win,
          avgMoves: row.avg_moves,
          bestStreak: row.best_streak,
          lastPlayed: row.last_played,
          achievements: row.achievements,
        })),
      ),
    };
  }

  // Delete my data: deletes or anonymises every row of this player, on every linked device, in one
  // transaction. A second call finds nothing and returns zero counts. Per table:
  // - sessions: the player's seats and seat request go, and the player's chat messages lose their
  //   text. A session that has no player and no move after that goes.
  // - results: a game that the player uploaded goes. An online game with another player stays for
  //   that player, and so does another player's upload: the player's seat becomes null.
  // - seat_metrics of the player's seats, player_names, the player's own blocks, private_stats, achievement_resets,
  //   achievement_players, seat_people, practice_runs: deleted.
  // - reports: a report about the player stays for moderation. A report that the player filed loses its reporter.
  // - tester_codes: a code that the player invited or claimed stays with its tester, without the player's person id and tokens.
  // - app_copies: the copies of the player's devices: deleted. Another copy loses its inviter when it is this player.
  // - player_tokens and users: the account goes, with its custom name and picture, so no device acts for it any more.
  // Limit: a device of the account that is still logged in links itself again on its next visit,
  // because its login cookie stays valid. That account then starts empty. Revisit this if the
  // server ever keeps login sessions that it can end.
  // Limit: the session query reads every session document, like myGames. Revisit it at the same size.
  // `token` is a device token, or the account token of a maintainer request (deleteDataOf).
  async function deleteFor(token: PlayerToken): Promise<DeletedData> {
    achievementCache.clear();
    // A deletion can change the games of other players too, so every player gets a check. Deletions are rare.
    checkAllAchievements();
    const identity = await identityOf(token);
    const ids = listValue([...identity]);
    const ownPersons = new Set(await Promise.all([...identity].map((owner) => personId(owner))));
    const persons = listValue([...ownPersons]);
    const [linked] = await rows('FROM player_tokens SELECT github_id WHERE token = $token', { token }, { github_id: bigId });
    const mine = (seat: string | null) => seat !== null && identity.has(seat);
    const counts = Object.fromEntries(DATA_TABLES.map((table) => [table, { deleted: 0, anonymised: 0 }])) as DeletedData;
    // The ids of the rows that a statement with `RETURNING ... AS id` changed.
    const changedIds = async (sql: string, values: Record<string, DuckDBValue>) => (await rows(sql, values, { id: text })).map((row) => row.id);
    const changed: Code[] = [];
    await db.run('BEGIN TRANSACTION');
    try {
      const held = await rows(
        `FROM sessions SELECT code
         WHERE list_contains($ids, doc.seats.X::VARCHAR) OR list_contains($ids, doc.seats.O::VARCHAR)
           OR list_contains($ids, doc.seatRequest.watcher::VARCHAR)
           OR list_has_any($persons, json_extract_string(doc::JSON, '$.chat[*].by'))`,
        { ids, persons },
        { code: codeColumn },
      );
      for (const { code } of held) {
        const { doc } = await loadRaw(code);
        const seats = { X: mine(doc.seats.X) ? null : doc.seats.X, O: mine(doc.seats.O) ? null : doc.seats.O };
        const freed = seats.X !== doc.seats.X || seats.O !== doc.seats.O;
        const seatRequest = freed || mine(doc.seatRequest?.watcher ?? null) ? null : doc.seatRequest;
        // The message keeps its id and seat, so the ids of later messages stay unique.
        const chat = doc.chat.map((message) => {
          if (isChatEvent(message) || message.by === undefined || !ownPersons.has(message.by)) return message;
          counts.chat_messages.anonymised++;
          return { id: message.id, from: message.from, text: DELETED_MESSAGE, at: message.at };
        });
        changed.push(code);
        if (seats.X === null && seats.O === null && core.isEmptySession(doc)) {
          await db.run('DELETE FROM sessions WHERE code = $code', { code });
          counts.sessions.deleted++;
          continue;
        }
        await db.run(`UPDATE sessions SET doc = $doc::JSON::VARIANT, ${SESSION_SEAT_SET}, version = version + 1, updated_at = now() WHERE code = $code`, {
          code,
          doc: serialize({ ...doc, seats, seatRequest, chat }),
        });
        counts.sessions.anonymised++;
      }

      // Before the seats of the results change: a metrics row finds its player through them.
      counts.seat_metrics.deleted = (
        await changedIds(
          `DELETE FROM seat_metrics WHERE EXISTS (FROM results r SELECT 1 WHERE r.public_id = seat_metrics.public_id
             AND ((seat_metrics.seat = 'X' AND list_contains($ids, r.player_x)) OR (seat_metrics.seat = 'O' AND list_contains($ids, r.player_o))))
           RETURNING public_id || seat AS id`,
          { ids },
        )
      ).length;

      // The games that this player uploaded, and the online games without another player.
      const deleted = await changedIds(
        `DELETE FROM results WHERE (list_contains($ids, token) AND mode IS DISTINCT FROM 'online')
           OR (mode = 'online' AND (list_contains($ids, player_x) OR list_contains($ids, player_o))
             AND coalesce(list_contains($ids, player_x), true) AND coalesce(list_contains($ids, player_o), true))
         RETURNING id`,
        { ids },
      );
      // An online game that stays has another player on the other seat, who becomes its uploader.
      const anonymised = new Set(
        await changedIds('UPDATE results SET token = CASE WHEN list_contains($ids, player_x) THEN player_o ELSE player_x END WHERE list_contains($ids, token) RETURNING id', { ids }),
      );
      for (const column of ['player_x', 'player_o'] as const) {
        for (const id of await changedIds(`UPDATE results SET ${column} = NULL WHERE list_contains($ids, ${column}) RETURNING id`, { ids })) anonymised.add(id);
      }
      counts.results = { deleted: deleted.length, anonymised: anonymised.size };

      counts.player_names.deleted = (await changedIds('DELETE FROM player_names WHERE list_contains($ids, token) RETURNING token AS id', { ids })).length;
      counts.blocks.deleted = (await changedIds('DELETE FROM blocks WHERE list_contains($ids, owner) RETURNING person AS id', { ids })).length;
      counts.private_stats.deleted = (await changedIds('DELETE FROM private_stats WHERE list_contains($ids, owner) RETURNING owner AS id', { ids })).length;
      counts.achievement_resets.deleted = (await changedIds('DELETE FROM achievement_resets WHERE list_contains($ids, owner) RETURNING owner AS id', { ids })).length;
      counts.achievement_players.deleted = (await changedIds('DELETE FROM achievement_players WHERE list_contains($ids, owner) RETURNING owner AS id', { ids })).length;
      counts.seat_people.deleted = (await changedIds('DELETE FROM seat_people WHERE list_contains($ids, token) RETURNING person AS id', { ids })).length;
      // A block of this player by another player stays for that player, without the name.
      counts.blocks.anonymised = (
        await changedIds('UPDATE blocks SET name = $name WHERE list_contains($persons, person) AND name <> $name RETURNING owner || person AS id', { persons, name: DELETED_NAME })
      ).length;
      counts.practice_runs.deleted = (await changedIds('DELETE FROM practice_runs WHERE list_contains($ids, token) RETURNING id', { ids })).length;
      // A code that this player invited or claimed stays with its tester, without the person id and tokens of this player.
      counts.tester_codes.anonymised = (
        await changedIds(
          `UPDATE tester_codes SET invited_by = CASE WHEN list_contains($persons, invited_by) THEN NULL ELSE invited_by END,
             claimed_token = CASE WHEN list_contains($ids, claimed_token) OR list_contains($ids, claimed_owner) THEN NULL ELSE claimed_token END,
             claimed_owner = CASE WHEN list_contains($ids, claimed_token) OR list_contains($ids, claimed_owner) THEN NULL ELSE claimed_owner END
           WHERE list_contains($persons, invited_by) OR list_contains($ids, claimed_token) OR list_contains($ids, claimed_owner) RETURNING id::VARCHAR AS id`,
          { persons, ids },
        )
      ).length;
      // The copies of this player's devices, or first opened by this player. A copy of another device keeps no invite
      // by this player.
      counts.app_copies.deleted = (
        await changedIds('DELETE FROM app_copies WHERE list_contains($ids, token) OR list_contains($ids, owner) RETURNING token AS id', { ids })
      ).length;
      // The device slots of this player's tokens: the purchase gets the place back.
      counts.apple_slots.deleted = (await changedIds('DELETE FROM apple_slots WHERE list_contains($ids, token) RETURNING device AS id', { ids })).length;
      counts.app_copies.anonymised = (
        await changedIds(
          'UPDATE app_copies SET invited_by = NULL WHERE list_contains($persons, invited_by) RETURNING token AS id',
          { persons },
        )
      ).length;
      counts.reports.anonymised = (
        await changedIds(
          `UPDATE reports SET reporter = NULL, reporter_person = NULL
           WHERE list_contains($ids, reporter) OR list_contains($persons, reporter_person) RETURNING id::VARCHAR AS id`,
          { ids, persons },
        )
      ).length;
      const account = linked?.github_id ?? null;
      counts.player_tokens.deleted = (
        await changedIds('DELETE FROM player_tokens WHERE list_contains($ids, token) OR github_id = $account RETURNING token AS id', { ids, account })
      ).length;
      // The notice tells the devices of other players to clean their copies (deletedSince).
      await db.run(
        `INSERT INTO deleted_people (person, deleted_at) SELECT unnest($persons), make_timestamptz($now * 1000)
         ON CONFLICT (person) DO UPDATE SET deleted_at = excluded.deleted_at`,
        { persons, now: now() },
      );
      if (account !== null) {
        counts.users.deleted = (await changedIds('DELETE FROM users WHERE github_id = $account RETURNING login AS id', { account })).length;
        counts.logins.deleted = (await changedIds('DELETE FROM logins WHERE github_id = $account RETURNING subject AS id', { account })).length;
      }
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    for (const code of changed) onChange(code);
    return counts;
  }

  // The achievements of every player against their games, once per start.
  checkAllAchievements();

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create: (token: PlayerToken, name: string, clock: TimeControl = NO_LIMIT): Promise<SessionView> =>
      serialized(async () => {
        const doc = core.createDoc({ name, mode: 'online', clock, seats: { X: await seatTokenOf(token), O: null } });
        for (let attempt = 0; attempt < 20; attempt++) {
          const code = newCode();
          try {
            await db.run(`INSERT INTO sessions (code, doc, seat_x, seat_o) VALUES ($code, $doc::JSON::VARIANT, ${SESSION_SEAT_VALUES})`, { code, doc: serialize(doc) });
          } catch (error) {
            if (error instanceof Error && error.message.includes('Duplicate key')) continue;
            throw error;
          }
          return view(await load(code), await identityOf(token));
        }
        throw new Error('could not find a free session code after 20 attempts');
      }),

    get: (code: Code, token: PlayerToken | undefined): Promise<SessionView> =>
      serialized(async () => view(await load(code), await identityOf(token))),

    join: async (code: Code, token: PlayerToken) => {
      const seatToken = await serialized(() => seatTokenOf(token));
      return change(code, token, (doc, identity) => core.join(doc, identity, seatToken));
    },
    move: (code: Code, token: PlayerToken, request: MoveRequest) =>
      change(code, token, (doc, identity) => core.move(doc, identity, request, now())),
    newGame: (code: Code, token: PlayerToken) => change(code, token, core.newGame),
    update: (code: Code, token: PlayerToken, changes: SessionUpdate) =>
      change(code, token, (doc, identity) => core.update(doc, identity, changes)),
    lock: (code: Code, token: PlayerToken) => change(code, token, core.lock),
    chat: async (code: Code, token: PlayerToken, text: unknown) => {
      const author = await serialized(async () => personId(await ownerOf(token)));
      return change(code, token, (doc, identity, watchers) => core.chat(doc, identity, text, now(), author, watchers));
    },
    playoff: (code: Code, token: PlayerToken, request: PlayoffRequest) =>
      change(code, token, (doc, identity) => core.playoff(doc, identity, request, now())),

    // Stores a finished practice run. A run with an id that this player sent before changes nothing.
    addPracticeRun: (token: PlayerToken, run: PracticeRun): Promise<{ stored: boolean }> =>
      serialized(async () => {
        const inserted = await rows(
          `INSERT INTO practice_runs (token, id, mode, preset, total_ms, round_ms, score, finished_at)
           VALUES ($token, $id, $mode, $preset, $total, $rounds::INTEGER[], $score, make_timestamptz($now * 1000))
           ON CONFLICT DO NOTHING RETURNING id`,
          {
            token,
            id: run.id,
            mode: run.mode,
            preset: run.preset,
            total: run.roundMs.reduce((sum, ms) => sum + ms, 0),
            rounds: listValue(run.roundMs),
            score: run.score,
            now: now(),
          },
          { id: text },
        );
        return { stored: inserted.length > 0 };
      }),

    // The leaderboard of one mode and preset, and the best run of the caller on all linked devices.
    practiceBoard: (mode: PracticeMode, preset: PresetId, token: PlayerToken | undefined): Promise<PracticeBoard> =>
      serialized(async () => practiceBoard(rows, mode, preset, [...(await identityOf(token))])),
    seat: (code: Code, token: PlayerToken, action: SeatAction) =>
      change(code, token, (doc, identity, watchers) => core.seat(doc, identity, action, watchers, now())),
    answerSeat: (code: Code, token: PlayerToken, accept: boolean) =>
      change(code, token, (doc, identity, watchers) => core.answerSeat(doc, identity, accept, watchers, now())),

    // The custom name of a player without a login, or null. `name` passed parseCustomName.
    customName: (token: PlayerToken): Promise<string | null> =>
      serialized(async () => {
        const [row] = await rows('FROM player_names SELECT name WHERE token = $token', { token }, { name: text });
        return row?.name ?? null;
      }),
    // The account of a linked device, with its name and picture choices, or null.
    account: (token: PlayerToken): Promise<PlayerInfo | null> =>
      serialized(async () => {
        const [row] = await rows(`FROM player_tokens JOIN users USING (github_id) SELECT ${ACCOUNT_COLUMN_LIST} WHERE token = $token`, { token }, ACCOUNT_COLUMNS);
        return row === undefined ? null : accountOf(row);
      }),
    // The name of a device, or of the account when `account` is the account id of the caller's login.
    // Refuses a name that equals the login of another GitHub account, so nobody can pose as a logged-in player.
    // A Google name is not unique, so a custom name may equal one, as two custom names may be equal.
    // Limit: a GitHub account that logs in later with the same login does not rename the player.
    // Revisit this if two players with one name confuse people in practice.
    setName: (token: PlayerToken, name: string, account: bigint | null): Promise<void> =>
      serialized(async () => {
        if (await isGitHubLoginOfOther(name, account)) throw new SessionError(409, 'That name is a GitHub login. Choose another name.');
        if (account !== null) {
          await db.run('UPDATE users SET name = $name WHERE github_id = $account', { name, account });
          return;
        }
        await db.run(
          `INSERT INTO player_names (token, name) VALUES ($token, $name)
           ON CONFLICT (token) DO UPDATE SET name = excluded.name, updated_at = now()`,
          { token, name },
        );
      }),
    clearName: (token: PlayerToken, account: bigint | null): Promise<void> =>
      serialized(async () => {
        if (account !== null) await db.run('UPDATE users SET name = NULL WHERE github_id = $account', { account });
        else await db.run('DELETE FROM player_names WHERE token = $token', { token });
      }),
    // The picture of an account. Each "generated" makes a new seed, so it also rerolls a generated picture.
    // "github" and "google" go back to the picture of the login that made the account, so only that one fits: 409.
    setAvatar: (account: bigint, picture: AvatarPicture): Promise<void> =>
      serialized(async () => {
        const seed = picture === 'generated' ? randomBytes(AVATAR_SEED_LENGTH / 2).toString('hex') : null;
        const updated = await rows(
          "UPDATE users SET seed = $seed WHERE github_id = $account AND ($picture = 'generated' OR provider = $picture) RETURNING github_id",
          { seed, account, picture },
          { github_id: bigId },
        );
        if (updated.length === 0) throw new SessionError(409, `This account has no ${picture === 'generated' ? 'row' : PROVIDER_NAMES[picture]} picture.`);
      }),

    // ---- Report and block ----

    // The people that the caller blocked, newest first, on every device of the account.
    blocks: (token: PlayerToken): Promise<BlockedPerson[]> =>
      serialized(async () => {
        const found = await rows(
          'FROM blocks SELECT person, name, epoch_ms(created_at) AS at WHERE owner = $owner ORDER BY created_at DESC, person',
          { owner: await ownerOf(token) },
          { person: personColumn, name: text, at: epoch },
        );
        return found;
      }),
    // Blocking twice keeps the first time and updates the name.
    block: (token: PlayerToken, person: PersonId, name: string): Promise<void> =>
      serialized(async () => {
        const owner = await ownerOf(token);
        if ((await personId(owner)) === person) throw new SessionError(400, 'You cannot block yourself.');
        const [counted] = await rows('FROM blocks SELECT count(*) AS n WHERE owner = $owner', { owner }, { n: int });
        if ((counted?.n ?? 0) >= BLOCKS_KEPT) throw new SessionError(409, `You can block at most ${BLOCKS_KEPT} people. Unblock someone first.`);
        await db.run(
          'INSERT INTO blocks (owner, person, name) VALUES ($owner, $person, $name) ON CONFLICT (owner, person) DO UPDATE SET name = excluded.name',
          { owner, person, name },
        );
      }),
    unblock: (token: PlayerToken, person: PersonId): Promise<void> =>
      serialized(async () => {
        await db.run('DELETE FROM blocks WHERE owner = $owner AND person = $person', { owner: await ownerOf(token), person });
      }),

    // "Hide my stats", on every device of the account.
    statsPrivate: (token: PlayerToken): Promise<boolean> => serialized(async () => isStatsPrivate(await ownerOf(token))),
    setStatsPrivate: (token: PlayerToken, hidden: boolean): Promise<void> =>
      serialized(async () => {
        const owner = await ownerOf(token);
        await db.run(hidden ? 'INSERT INTO private_stats (owner) VALUES ($owner) ON CONFLICT DO NOTHING' : 'DELETE FROM private_stats WHERE owner = $owner', { owner });
      }),

    // Stores a report of a message or a person of an online session. The session must hold the target now.
    // A report without a code names a person of the stats page: any person with a finished game or an account.
    report: (token: PlayerToken, request: ReportRequest): Promise<{ id: number }> =>
      serialized(async () => {
        const reporter = await ownerOf(token);
        const store = async (code: Code | null, target: { message: number | null; text: string | null; person: PersonId | null; name: string | null }) => {
          const [stored] = await rows(
            `INSERT INTO reports (code, message, message_text, person, person_name, reason, note, reporter, reporter_person)
             VALUES ($code, $message, $text, $person, $name, $reason, $note, $reporter, $reporterPerson) RETURNING id`,
            { code, ...target, reason: request.reason, note: request.note, reporter, reporterPerson: await personId(reporter) },
            { id: int },
          );
          if (stored === undefined) throw new Error('a report insert returned no id');
          return { id: stored.id };
        };
        if (request.code === null) {
          const id = request.target.person;
          const found = await statsPersonOf(id);
          if (found === undefined) throw new SessionError(404, 'That player has no finished games.');
          return store(null, { message: null, text: null, person: id, name: found.shown.name });
        }
        const row = await load(request.code);
        const { watchers } = await audience(row.code, row.doc);
        const everyone = [row.doc.seats.X, row.doc.seats.O, ...watchers.map((watcher) => watcher.token)];
        const person = await personsOf(everyone);
        const name = await namesOf(everyone);
        let target: { message: number | null; text: string | null; person: PersonId | null; name: string | null };
        if ('message' in request.target) {
          const id = request.target.message;
          const message = row.doc.chat.find((entry) => entry.id === id);
          // An event has no writer and no text, so nobody can report it.
          if (message === undefined || isChatEvent(message)) throw new SessionError(404, 'That message is not in the chat any more.');
          // The writer by person id. An older message without one stands for the holder of its seat.
          const byPerson = message.by;
          const author =
            byPerson !== undefined
              ? (everyone.find((candidate) => candidate !== null && person(candidate) === byPerson) ?? null)
              : message.from === 'watcher'
                ? null
                : row.doc.seats[message.from];
          target = { message: id, text: message.text, person: byPerson ?? (author === null ? null : person(author)), name: author === null ? null : name(author) };
        } else {
          const id = request.target.person;
          const found = everyone.find((candidate) => candidate !== null && person(candidate) === id);
          if (found === undefined || found === null) throw new SessionError(404, 'That person is not in this game now.');
          target = { message: null, text: null, person: id, name: name(found) };
        }
        return store(row.code, target);
      }),

    // The newest reports and moderation actions, for the maintainers.
    reports: (): Promise<{ reports: StoredReport[]; actions: ModerationAction[] }> =>
      serialized(async () => {
        const reports = await rows(
          `FROM reports r LEFT JOIN player_tokens t ON t.token = r.reporter LEFT JOIN users u ON u.github_id = t.github_id
           SELECT r.id, r.code, r.message, r.message_text AS text, r.person, r.person_name AS name, r.reason, r.note,
             r.reporter_person AS reporter, u.login AS reporterLogin, epoch_ms(r.created_at) AS at
           ORDER BY r.id DESC LIMIT ${REPORTS_SHOWN}`,
          {},
          {
            id: int,
            code: nullable(codeColumn),
            message: nullable(int),
            text: nullable(text),
            person: nullable(personColumn),
            name: nullable(text),
            reason: oneOf(REPORT_REASONS),
            note: nullable(text),
            reporter: nullable(personColumn),
            reporterLogin: nullable(text),
            at: epoch,
          },
        );
        const actions = await rows(
          `FROM moderation_log SELECT login, action, code, message, person, epoch_ms(created_at) AS at ORDER BY created_at DESC LIMIT ${REPORTS_SHOWN}`,
          {},
          { login: text, action: oneOf(['hide-message', 'clear-name'] as const), code: nullable(codeColumn), message: nullable(int), person: nullable(personColumn), at: epoch },
        );
        return { reports, actions };
      }),

    // A maintainer hides a chat message for everyone: its text becomes REMOVED_MESSAGE. The message
    // keeps its id, so the next message never takes the id of a message that a page hid on report.
    hideMessage: (code: Code, message: number, login: string): Promise<void> =>
      serialized(async () => {
        const row = await load(code);
        if (!row.doc.chat.some((entry) => entry.id === message && !isChatEvent(entry))) throw new SessionError(404, 'That message is not in the chat.');
        const chat = row.doc.chat.map((entry) => (entry.id === message && !isChatEvent(entry) ? { ...entry, text: REMOVED_MESSAGE } : entry));
        await save(row, { ...row.doc, chat });
        await logModeration(login, 'hide-message', { code, message });
      }),

    // A maintainer clears the custom name of a person: of a device, or of an account. Returns the tokens
    // that lost a name, so the HTTP layer tells their open sessions. DuckDB's sha256 finds the token behind the person id.
    clearNameOf: (person: PersonId, login: string): Promise<string[]> =>
      serialized(async () => {
        const cleared = await rows(
          `DELETE FROM player_names WHERE left(sha256($prefix || token), ${PERSON_ID_LENGTH}) = $person RETURNING token`,
          { prefix: PERSON_ID_PREFIX, person },
          { token: text },
        );
        const accounts = await rows(
          `UPDATE users SET name = NULL
           WHERE name IS NOT NULL AND left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), ${PERSON_ID_LENGTH}) = $person
           RETURNING github_id`,
          { prefix: PERSON_ID_PREFIX, account: ACCOUNT_TOKEN_PREFIX, person },
          { github_id: bigId },
        );
        for (const { github_id } of accounts) {
          cleared.push(...(await rows('FROM player_tokens SELECT token WHERE github_id = $id', { id: github_id }, { token: text })));
        }
        if (cleared.length === 0) throw new SessionError(404, 'That person has no custom name.');
        await logModeration(login, 'clear-name', { person });
        return cleared.map((row) => row.token);
      }),

    // Links this browser to the account of a login, and returns the account id.
    linkToken: (token: PlayerToken, user: LoginUser): Promise<bigint> =>
      serialized(async () => {
        const id = await accountOfLogin(user);
        // The games of the device move to the account, also from an account that the device was linked to before.
        changedOwners.add(await ownerOf(token));
        changedOwners.add(token);
        changedOwners.add(accountToken(id));
        // The players who met this device now meet the account, so the opponent of their games changes.
        // An achievement about different people can lock again: two devices of one person count once.
        const met = await rows(`FROM ${seatedResults(1)} results SELECT results.player_x AS x, results.player_o AS o`, tokenValues([token]), {
          x: nullable(text),
          o: nullable(text),
        });
        const others = met.flatMap((row) => [row.x, row.o]).filter((seat): seat is string => seat !== null && seat !== token && seat !== core.COMPUTER_TOKEN);
        for (const owner of (await canonical(others)).values()) changedOwners.add(owner);
        achievementCache.clear();
        await db.run(
          `INSERT INTO player_tokens (token, github_id) VALUES ($token, $id)
           ON CONFLICT (token) DO UPDATE SET github_id = excluded.github_id, linked_at = now()`,
          { token, id },
        );
        await ensureAccountRow(id);
        return id;
      }),

    // A sign-in without a device, at the login callback: makes the account, or refreshes its name and picture.
    signIn: (user: LoginUser): Promise<bigint> => serialized(() => accountOfLogin(user)),

    // Adds a login of the other provider to the account of `current`, so both logins open the same account.
    // A login that already has its own account brings it along: mergeAccounts moves it into this one.
    connectLogin: (current: LoginUser, adding: LoginUser): Promise<void> =>
      serialized(async () => {
        const { provider, subject, label } = loginKey(adding);
        if (provider === loginKey(current).provider) throw new Error('a login connects only a login of the other provider');
        const account = await accountOfLogin(current);
        const found = await knownAccountOf(adding);
        if (found === account) return;
        const [other] = await rows('FROM logins SELECT subject WHERE provider = $provider AND github_id = $account', { provider, account }, { subject: text });
        if (other !== undefined) throw new SessionError(409, `This account already has another ${PROVIDER_NAMES[provider]} login.`);
        if (found !== undefined) await mergeAccounts(account, found);
        else await db.run('INSERT INTO logins (provider, subject, github_id, label) VALUES ($provider, $subject, $account, $label)', { provider, subject, account, label });
      }),

    // The logins of the account of this device: the GitHub login, and whether it has Google.
    loginsOf: (token: PlayerToken): Promise<{ github: string | null; google: boolean }> =>
      serialized(async () => {
        const found = await rows(
          'FROM player_tokens JOIN logins USING (github_id) SELECT provider, label WHERE token = $token',
          { token },
          { provider: oneOf(LOGIN_PROVIDERS), label: nullable(text) },
        );
        return { github: found.find((row) => row.provider === 'github')?.label ?? null, google: found.some((row) => row.provider === 'google') };
      }),

    // Logout: this browser no longer acts for its account. The other devices of the account stay linked.
    // A seat that holds this device token goes to the account first: a session from before account
    // seats, or a seat taken before the login. The account keeps it, and this browser loses it.
    // Every finished result that names this device token also goes to the account: the uploader
    // (`token`) and both seat columns, also results from before the login. The browser then lists and
    // counts none of them. A Nearby host row that names this device as the guest moves too, so the
    // guest dedupe (HOST_HAS_GAME) still matches. hidden_x and hidden_o stay: a cleared seat stays cleared.
    // Limit: the session query reads the seats of every session document, like myGames, and the result
    // updates scan the results table. Revisit this at about 100,000 sessions or results, or when a
    // logout takes more than about 100 ms.
    unlinkToken: (token: PlayerToken): Promise<void> =>
      serialized(async () => {
        const [linked] = await rows('FROM player_tokens SELECT github_id WHERE token = $token', { token }, { github_id: bigId });
        if (linked === undefined) return;
        const account = await ensureAccountRow(linked.github_id);
        const held = await rows(
          `FROM ${seatedRows('sessions', 'seat_x', 'seat_o', 1)} sessions SELECT code`,
          tokenValues([token]),
          { code: codeColumn },
        );
        for (const { code } of held) {
          const row = await loadRaw(code);
          const seats = { X: row.doc.seats.X === token ? account : row.doc.seats.X, O: row.doc.seats.O === token ? account : row.doc.seats.O };
          await save(row, { ...row.doc, seats });
        }
        for (const column of ['token', 'player_x', 'player_o'] as const) {
          await db.run(`UPDATE results SET ${column} = $account WHERE ${column} = $token`, { account, token });
        }
        await db.run('DELETE FROM player_tokens WHERE token = $token', { token });
      }),

    // Stores finished games from a device. A result already stored (same id) is skipped, so a
    // device can send again after a lost answer. Returns how many results were new, and the
    // public id of each result that has another public id on the server than the device sent:
    // a result without one, or one whose id another game holds already.
    addResults: (token: PlayerToken, uploads: readonly unknown[]): Promise<{ stored: number; renamed: Record<string, DeviceGameId> }> =>
      serialized(async () => {
        const results = uploads.map((upload) => parseResultUpload(upload, now()));
        if (!results.every((result): result is ResultUpload => result !== undefined)) {
          throw new SessionError(400, 'A result is not a valid finished game.');
        }
        if (results.some((result) => result.guest === token)) throw new SessionError(400, 'The guest of a Nearby game needs its own player token.');
        let stored = 0;
        const renamed: Record<string, DeviceGameId> = {};
        for (const result of results) {
          // An uploaded result id never holds ':', so this row is an upload and not an online game (see recordOnline).
          const [existing] = await rows('FROM results SELECT public_id WHERE id = $id', { id: result.id }, { public_id: nullable(deviceGameId) });
          // A row from before game links has no public id. The device then keeps the id it has.
          if (existing?.public_id === null) continue;
          let publicId = existing?.public_id ?? result.publicId ?? newGameId();
          if (existing === undefined) {
            // The metrics go to their own column, and the guest's token to its seat column, not into the stored game.
            const { metrics, guest, ...upload } = result;
            for (let attempt = 1; ; attempt++) {
              try {
                const doc = { ...upload, publicId };
                await insertResult({ id: result.id, token, doc, finishedAt: result.finishedAt, publicId, seats: seatTokens(token, result.you, guest), game: result.game, metrics });
                break;
              } catch (error) {
                if (!isDuplicateKey(error) || attempt >= MAX_ID_ATTEMPTS) throw error;
                publicId = newGameId();
              }
            }
            stored++;
          }
          if (publicId !== result.publicId) renamed[result.id] = publicId;
        }
        return { stored, renamed };
      }),

    // One finished game for its read-only link. 404 for an unknown id.
    game: (id: GameId): Promise<PublicGame> =>
      serialized(async () => {
        const [row] = await rows(
          `FROM results ${SEAT_ACCOUNTS} SELECT doc::JSON AS doc, epoch_ms(finished_at) AS finished, ${SEAT_ACCOUNT_COLUMNS},
             results.player_x AS token_x, results.player_o AS token_o
           WHERE public_id = $id`,
          { id },
          { doc: json, finished: epoch, ...SEAT_SHAPE },
        );
        if (row === undefined) return onlineGameFromSession(id);
        const stored = readStored(row.doc);
        // parsePublicGame checks the answer. Its fixed list of fields keeps tokens and result ids out.
        return parsePublicGame({
          id,
          mode: stored.mode,
          game: stored.game,
          options: stored.options,
          difficulty: stored.difficulty,
          tuned: stored.tuned,
          computer: stored.mode === 'computer' && stored.you !== null ? other(stored.you) : null,
          players: { X: accountOf({ provider: row.x_provider, login: row.x_login, avatar: row.x_avatar, name: row.x_name, seed: row.x_seed }), O: accountOf({ provider: row.o_provider, login: row.o_login, avatar: row.o_avatar, name: row.o_name, seed: row.o_seed }) },
          names: await seatNames(row.token_x, row.token_o),
          finishedAt: row.finished,
        });
      }),

    // The finished games of this player in every mode, on all their linked devices, newest first.
    history: (token: PlayerToken, offset: number): Promise<HistoryPage> =>
      serialized(async () => {
        if (!Number.isInteger(offset) || offset < 0) throw new SessionError(400, 'The offset is not a whole number of games.');
        const tokens = [...(await identityOf(token))];
        // A seat that its player cleared (clearHistory) is not in the history.
        const found = await rows(
          `FROM ${seatedResults(tokens.length)} results ${SEAT_ACCOUNTS}
           SELECT results.public_id, results.mode, results.level AS difficulty,
             results.winner, results.ending, CASE WHEN results.ending IS NULL THEN results.doc::JSON END AS old_doc,
             len(results.moves) AS moves, epoch_ms(results.finished_at) AS finished,
             coalesce(${inTokens('results.player_x', tokens.length)}, false) AS mine_x,
             coalesce(${inTokens('results.player_o', tokens.length)}, false) AS mine_o, ${SEAT_ACCOUNT_COLUMNS},
             results.player_x AS token_x, results.player_o AS token_o
           WHERE ((mine_x AND results.hidden_x IS NOT TRUE) OR (mine_o AND results.hidden_o IS NOT TRUE))
             AND NOT ${HOST_HAS_GAME}
           ORDER BY results.finished_at DESC, results.id
           LIMIT $limit OFFSET $offset`,
          { ...tokenValues(tokens), limit: HISTORY_PAGE_SIZE + 1, offset },
          {
            public_id: nullable(gameId),
            mode: oneOf(SESSION_MODES),
            difficulty: nullable(oneOf(DIFFICULTIES)),
            winner: nullable(oneOf(SEATS)),
            ending: nullable(text),
            old_doc: nullable(json),
            moves: int,
            finished: epoch,
            mine_x: bool,
            mine_o: bool,
            ...SEAT_SHAPE,
          },
        );
        const name = await namesOf(found.flatMap((row) => [row.token_x, row.token_o]));
        const games = found.slice(0, HISTORY_PAGE_SIZE).map((row): HistoryEntry => {
          // A friend game holds this player on both seats.
          const you: Player | null = row.mine_x && row.mine_o ? null : row.mine_x ? 'X' : 'O';
          // A row from before game links has no ending columns: replay its game.
          const winner = row.ending === null ? endingOf(readStored(row.old_doc).game).winner : row.winner;
          return {
            // A row from before game links has no public id, so it has no link.
            id: row.public_id,
            mode: row.mode,
            difficulty: row.difficulty,
            result: outcomeOf(winner, you),
            moves: row.moves,
            opponent: you === 'X' ? accountOf({ provider: row.o_provider, login: row.o_login, avatar: row.o_avatar, name: row.o_name, seed: row.o_seed }) : you === 'O' ? accountOf({ provider: row.x_provider, login: row.x_login, avatar: row.x_avatar, name: row.x_name, seed: row.x_seed }) : null,
            opponentName: you === 'X' ? core.seatName(row.token_o, name) : you === 'O' ? core.seatName(row.token_x, name) : null,
            finishedAt: row.finished,
          };
        });
        // The same check as on the page, so a wrong cast above fails here and not in a browser.
        return parseHistoryPage({ games, more: found.length > HISTORY_PAGE_SIZE });
      }),

    // The survival records of this player on all their linked devices: per setup, the most moves
    // of a game that the computer won. Same keys as the records on the device (src/records.ts).
    records: (token: PlayerToken): Promise<Records> =>
      serialized(async () => {
        const tokens = [...(await identityOf(token))];
        // A cleared game still counts: a record is a best value per setup, not a history entry.
        // The replay below also reads rows from before game links, which have no winner column.
        const found = await rows(
          `FROM ${seatedResults(tokens.length)} results SELECT doc::JSON AS doc WHERE mode = 'computer'`,
          tokenValues(tokens),
          { doc: json },
        );
        let records: Records = {};
        for (const row of found) {
          const { game, difficulty, options, tuned, you } = readStored(row.doc);
          if (difficulty === null || you === null) throw new Error('a stored computer game has no level or no seat');
          const { winner } = endingOf(game);
          if (winner === null || winner === you) continue;
          records = addLoss(records, { difficulty, clock: game.clock, ...options, tuned }, game.moves.length).records;
        }
        return records;
      }),

    // The achievements of this player over every finished game on all their linked devices, and their rarity.
    // A cleared game still counts: an achievement stays once the player earned it.
    achievements: (token: PlayerToken): Promise<Achievements> => serialized(async () => achievementsOf(await ownerOf(token), [...(await identityOf(token))])),

    // The public person id of this player: of the account when the device is linked (GET /api/me).
    person: (token: PlayerToken): Promise<PersonId> => serialized(async () => personId(await ownerOf(token))),

    // "Reset achievements", on every device of the account: from now on, only new games count.
    // "Clear history" leaves the achievements alone.
    resetAchievements: (token: PlayerToken): Promise<void> =>
      serialized(async () => {
        const owner = await ownerOf(token);
        await db.run(
          `INSERT INTO achievement_resets (owner, reset_at) VALUES ($owner, make_timestamptz($at * 1000))
           ON CONFLICT (owner) DO UPDATE SET reset_at = excluded.reset_at`,
          { owner, at: now() },
        );
        achievementCache.clear();
        changedOwners.add(owner);
      }),

    // Hides every finished game of this player from their history, on all linked devices.
    // The other seat of a shared game keeps it, and the stats and survival records still count it.
    // Returns how many seats it hid.
    clearHistory: (token: PlayerToken): Promise<number> =>
      serialized(async () => {
        const tokens = [...(await identityOf(token))];
        let hidden = 0;
        for (const [column, seat] of [['hidden_x', 'player_x'], ['hidden_o', 'player_o']] as const) {
          const changed = await rows(
            `UPDATE results SET ${column} = true WHERE ${inTokens(seat, tokens.length)} AND ${column} IS NOT TRUE RETURNING id`,
            tokenValues(tokens),
            { id: text },
          );
          hidden += changed.length;
        }
        return hidden;
      }),

    // Delete my data for this device, and for the account when the device is logged in (deleteFor).
    deleteData: (token: PlayerToken): Promise<DeletedData> => serialized(() => deleteFor(token)),

    // The same deletion for an email request, by a maintainer: by public person id, or by GitHub login.
    // 404 when nobody has that id or login. A person id names a canonical token (see canonical), so the
    // search reads the columns that hold tokens of people. Limit: it scans those columns. Revisit this
    // when one call takes more than about a second.
    deleteDataOf: (target: { person: PersonId } | { login: string }): Promise<DeletedData> =>
      serialized(async () => {
        let token: string | undefined;
        if ('login' in target) {
          const [user] = await rows(
            "FROM logins SELECT github_id WHERE provider = 'github' AND lower(label) = lower($login)",
            { login: target.login },
            { github_id: bigId },
          );
          if (user !== undefined) token = await ensureAccountRow(user.github_id);
        } else {
          const [found] = await rows(
            `WITH tokens AS (
               FROM player_tokens SELECT token UNION FROM player_names SELECT token UNION FROM practice_runs SELECT token
               UNION FROM blocks SELECT owner UNION FROM results SELECT token UNION FROM results SELECT player_x UNION FROM results SELECT player_o
               UNION FROM sessions SELECT doc.seats.X::VARCHAR UNION FROM sessions SELECT doc.seats.O::VARCHAR)
             FROM tokens SELECT token WHERE token IS NOT NULL AND left(sha256($prefix || token), ${PERSON_ID_LENGTH}) = $person LIMIT 1`,
            { prefix: PERSON_ID_PREFIX, person: target.person },
            { token: text },
          );
          token = found?.token;
        }
        if (token === undefined) throw new SessionError(404, 'Nobody has that person id or GitHub login.');
        // An account token is not a valid X-Player value, but identityOf reads it like a device token of the account.
        return deleteFor(token as PlayerToken);
      }),

    // The metrics of one player's device for a finished online game. The first report per seat
    // counts, so a page that sends again changes nothing. Returns false for a repeat.
    addSeatMetrics: (id: GameId, token: PlayerToken, metrics: Metrics): Promise<boolean> =>
      serialized(async () => {
        if (!isOnlineGameId(id)) throw new SessionError(400, 'Only an online game takes metrics here. Other games send them with the result.');
        const { row, index } = await finishedOnlineGame(id);
        const seatNow = core.seatsOf(row.doc, await identityOf(token))[0];
        if (seatNow === undefined) throw new SessionError(403, 'Only the two players can send metrics for this game.');
        // The seats rotate between games: the report counts for the seat that this player held in that game.
        const seat = seatIn(row.doc.flipped, index, seatNow);
        const inserted = await rows(
          `INSERT INTO seat_metrics (public_id, seat, metrics, ${METRIC_COLUMN_LIST}) VALUES ($id, $seat, $metrics::JSON::VARIANT, ${METRIC_VALUES})
           ON CONFLICT DO NOTHING RETURNING seat`,
          { id, seat, metrics: JSON.stringify(metrics) },
          { seat: text },
        );
        return inserted.length > 0;
      }),

    // True when the version is new. A known version keeps its name (see the releases table).
    addRelease: ({ version, name, at }: Release): Promise<boolean> =>
      serialized(async () => {
        const inserted = await rows(
          `INSERT INTO releases (version, name, released_at) VALUES ($version, $name, make_timestamptz($at * 1000))
           ON CONFLICT DO NOTHING RETURNING version`,
          { version, name, at },
          { version: text },
        );
        return inserted.length > 0;
      }),

    // Adds the codes that the table does not hold yet. A known code keeps its row and its claim. Returns how many are new.
    addTesterCodes: (entries: readonly TesterCodeEntry[]): Promise<number> =>
      serialized(async () => {
        let added = 0;
        for (const { code, name } of entries) {
          const inserted = await rows(
            `INSERT INTO tester_codes (code, name, claimed_at) VALUES ($code, $name, CASE WHEN $name IS NULL THEN NULL ELSE now() END)
             ON CONFLICT DO NOTHING RETURNING id`,
            { code, name },
            { id: int },
          );
          added += inserted.length;
        }
        return added;
      }),

    // The public list: a hint of each code, and the name and Gravatar hash of a claim. Never a code or an email.
    testerCodes: (): Promise<TesterCodes> =>
      serialized(async () => {
        const found = await rows('FROM tester_codes SELECT id, code, name, email ORDER BY id', {}, { id: int, code: text, name: nullable(text), email: nullable(text) });
        return {
          codes: found.map(({ id, code, name, email }) => ({
            id,
            hint: hintOf(code),
            claimed: name !== null,
            name,
            gravatar: email === null ? null : gravatarOf(email),
          })),
        };
      }),

    // Gives the code to the tester once. 404 for an unknown id, 409 when somebody claimed it already.
    // `token` is the player of the claimer. An invite from one of their own persons (a device or the account)
    // is a self-invite, and counts for nobody.
    // Limit: the server cannot tell an unknown person id from the id of a device that never played, so it keeps
    // any well-formed `by`. Revisit this if fake invites show up in GET /api/testing/claims.
    claimTesterCode: (id: number, { email, name, by }: ClaimRequest, token: PlayerToken): Promise<ClaimedCode> =>
      serialized(async () => {
        const own = await personsOfTokens([...(await identityOf(token))]);
        const invitedBy = by !== null && !own.has(by) ? by : null;
        const [claimed] = await rows(
          `UPDATE tester_codes SET claimed_at = now(), name = $name, email = $email, invited_by = $invitedBy, claimed_token = $token, claimed_owner = $owner
           WHERE id = $id AND claimed_at IS NULL RETURNING code`,
          { id, name, email, invitedBy, token, owner: await ownerOf(token) },
          { code: text },
        );
        if (claimed !== undefined) {
          if (invitedBy !== null) {
            await inviteChanged(invitedBy);
          }
          return claimed;
        }
        const [known] = await rows('FROM tester_codes SELECT id WHERE id = $id', { id }, { id: int });
        if (known === undefined) throw new SessionError(404, 'No tester code has this id.');
        throw new SessionError(409, 'Somebody else took this code a moment ago. Pick another one.');
      }),

    // The Android app opened on this device (POST /api/copies), with the inviter that /share kept, or null. The first
    // open makes the copy of the device. Its owner then (an account or the device) stays for the invite events only:
    // the copy itself follows the account that holds the device now (hasCopyOf). A later open only adds an inviter
    // that the copy lacks; the first inviter wins. A self-invite counts for nobody. Answers whether the player holds a copy.
    // Only a verified store proof sets proved. Old rows remain unproved.
    reportAppOpen: (token: PlayerToken, by: PersonId | null, proof: boolean | ApplePurchase = false): Promise<boolean> =>
      serialized(async () => {
        if (typeof proof !== 'boolean') await takeAppleSlot(token, proof);
        const invitedBy = by !== null && !(await personsOfTokens([...(await identityOf(token))])).has(by) ? by : null;
        const changed = await rows(
          `INSERT INTO app_copies (token, owner, invited_by, proved) VALUES ($token, $owner, $by, $proved)
           ON CONFLICT (token) DO UPDATE SET invited_by = coalesce(app_copies.invited_by, excluded.invited_by), proved = app_copies.proved OR excluded.proved
           RETURNING invited_by`,
          { token, owner: await ownerOf(token), by: invitedBy, proved: proof !== false },
          { invited_by: nullable(text) },
        );
        if (invitedBy !== null && changed[0]?.invited_by === invitedBy) {
          await inviteChanged(invitedBy);
        }
        return hasCopyOf(token);
      }),

    // A valid, player-bound negative Play verdict revokes only this device, not its account's other devices.
    // Limit: Apple refunds are not checked. Revisit when a player reports a refund.
    revokePlayCopy: (token: PlayerToken): Promise<boolean> => serialized(async () => {
      await db.run('UPDATE app_copies SET proved = false WHERE token = $token', { token });
      return hasCopyOf(token);
    }),

    hasCopy: (token: PlayerToken): Promise<boolean> => serialized(() => hasCopyOf(token)),

    // The claims with their emails, oldest first, for the maintainers (they add the emails to the Google Group).
    testerClaims: (): Promise<TesterClaims> =>
      serialized(async () => {
        const found = await rows(
          'FROM tester_codes SELECT code, name, email, epoch_ms(claimed_at) AS at, invited_by WHERE claimed_at IS NOT NULL ORDER BY claimed_at, id',
          {},
          { code: text, name: text, email: nullable(text), at: epoch, invited_by: nullable(personColumn) },
        );
        return { claims: found.map(({ code, name, email, at, invited_by }) => ({ hint: hintOf(code), name, email, claimedAt: at, invitedBy: invited_by })) };
      }),

    addEvent: (event: ClientEvent): Promise<void> =>
      serialized(async () => {
        await db.run('INSERT INTO events (kind, message, version) VALUES ($kind, $message, $version)', event);
      }),

    // The aggregates of the stats page. An Everyone answer is at most STATS_CACHE_MS old. A Mine answer
    // (`token` is the player) and a person answer have no cache, so a game shows at once.
    // A person filter answers 403 when that person hides their stats, except to the person.
    // Limit: each Mine or person call runs all queries. Revisit this when such a call takes more than about 200 ms.
    stats: (filter: StatsFilter = ALL_STATS, token: PlayerToken | null = null): Promise<Stats> => {
      if (filter.scope === 'everyone' && filter.person === null) {
        return snapshot(`stats ${statsQuery(filter)}`, async () => ({
          ...(await computeStats(readRows, now(), filter, null)),
          person: null,
          practice: await practiceStats(readRows),
          achievements: null,
        }));
      }
      return serialized(async () => {
        if (filter.scope === 'mine') {
          if (token === null) throw new SessionError(400, 'Your stats need the X-Player header.');
          const tokens = [...(await identityOf(token))];
          return { ...(await computeStats(rows, now(), filter, tokens)), person: null, practice: await practiceStats(rows), achievements: await achievementsOf(await ownerOf(token), tokens) };
        }
        if (filter.person !== null) {
          const found = await visiblePersonOf(filter.person, token);
          return {
            ...(await computeStats(rows, now(), filter, found.tokens)),
            person: found.person,
            practice: await practiceStats(rows),
            achievements: await achievementsOf(found.owner, found.tokens),
          };
        }
        throw new Error('the Everyone stats come from a snapshot');
      });
    },

    // The player card of a person view: the name, and the unlocks of achievement_players, newest first.
    // It reads no game, so the card shows before the stats of the person. The same 403 and 404 as a person filter.
    statsCard: (person: PersonId, token: PlayerToken | null): Promise<StatsCard> =>
      serialized(async () => {
        const found = await visiblePersonOf(person, token);
        await refreshAchievements();
        const [row] = await rows('FROM achievement_players SELECT to_json(unlocked) AS unlocked WHERE owner = $owner', { owner: found.owner }, { unlocked: json });
        const unlocked = row === undefined ? [] : row.unlocked;
        if (!Array.isArray(unlocked)) throw new Error('achievement_players holds a row that is not a list');
        return { person: found.person, unlocked: unlocked.map((id) => oneOf(ACHIEVEMENT_IDS)(id)) };
      }),

    // The leaderboard of a range, mode and level, from a snapshot (see snapshot). `you` is the person of the
    // caller, when the X-Player header names one.
    leaderboard: async (filter: StatsFilter, token: PlayerToken | undefined): Promise<Leaderboard> => {
      const you = token === undefined ? null : await serialized(async () => personId(await ownerOf(token)));
      return { ...(await snapshot(`leaderboard ${statsQuery(filter)}`, () => leaderboardOf(filter))), you };
    },

    // Every session and result of this player, on all their linked devices. It makes at most 6 queries, whatever
    // the number of sessions: the seat indexes find the sessions and the results.
    // Limit: it parses every result of the player in JS, and other requests wait in the queue meanwhile.
    // Revisit this when one player has about 10,000 results. Counting the outcomes in SQL then helps.
    myGames: (token: PlayerToken): Promise<MyGames> =>
      serialized(async () => {
        const identity = await identityOf(token);
        const tokens = [...identity];
        const total = emptyTally();
        const byMode = Object.fromEntries(SESSION_MODES.map((mode) => [mode, emptyTally()])) as MyGames['byMode'];
        const byDifficulty = Object.fromEntries(DIFFICULTIES.map((level) => [level, emptyTally()])) as MyGames['byDifficulty'];

        const sessionRows = await rows(
          `FROM ${seatedRows('sessions', 'seat_x', 'seat_o', tokens.length)} sessions SELECT code, doc::JSON AS doc, epoch_ms(updated_at) AS updated
           ORDER BY updated_at DESC`,
          tokenValues(tokens),
          { code: codeColumn, doc: json, updated: epoch },
        );
        const seated: { code: Code; doc: SessionDoc; you: Player; updated: EpochMs }[] = [];
        for (const row of sessionRows) {
          const doc = parseDoc(row.doc);
          const you = core.seatsOf(doc, identity)[0];
          if (you === undefined) continue;
          seated.push({ code: row.code, doc, you, updated: row.updated });
          for (const [index, record] of doc.games.entries()) {
            const game = toGame(record);
            if (game.status.kind === 'playing') continue;
            const winner = winnerOf(game.status);
            // The seats rotate between games, so the seat of this player in that game can differ from now.
            const outcome = winner === null ? 'drawn' : winner === seatIn(doc.flipped, index, you) ? 'won' : 'lost';
            count(total, outcome);
            count(byMode.online, outcome);
          }
        }
        // One query for the accounts and one for the names of every opponent, not two per session.
        const opponents = seated.map(({ doc, you }) => doc.seats[other(you)]);
        const opponentAccount = await accountsOf(opponents);
        const nameOf = await namesOf(opponents);
        const sessions = seated.map(({ code, doc, you, updated }): SessionSummary => {
          const live = core.currentGame(doc);
          const opponent = doc.seats[other(you)];
          return {
            code,
            name: doc.name,
            games: doc.games.filter((record) => record.moves.length > 0).length,
            you,
            opponent: opponentAccount(opponent),
            opponentName: core.seatName(opponent, nameOf),
            yourTurn: live.status.kind === 'playing' && live.turn === you && opponent !== null,
            updatedAt: updated,
          };
        });

        // The online rows of results repeat the session games counted above, so they stay out.
        const resultRows = await rows(
          `FROM ${seatedResults(tokens.length)} results SELECT doc::JSON AS doc WHERE ${inTokens('results.token', tokens.length)} AND mode <> 'online'`,
          tokenValues(tokens),
          { doc: json },
        );
        for (const row of resultRows) {
          const result = parseResultUpload(row.doc, now());
          if (result === undefined) throw new Error('a stored result does not parse');
          const winner = winnerOf(toGame(result.game).status);
          // A friend game has no "you": both seats played on one device, so it only counts as played.
          const outcome = result.you === null ? 'played' : winner === null ? 'drawn' : winner === result.you ? 'won' : 'lost';
          count(total, outcome);
          count(byMode[result.mode], outcome);
          if (result.difficulty !== null) count(byDifficulty[result.difficulty], outcome);
        }

        const [user] = await rows(
          `FROM player_tokens JOIN users USING (github_id) SELECT ${ACCOUNT_COLUMN_LIST} WHERE token = $token`,
          { token },
          ACCOUNT_COLUMNS,
        );
        return {
          user: user === undefined ? null : accountOf(user),
          total,
          byMode,
          byDifficulty,
          sessions,
        };
      }),

    // Deletes sessions that no game has a move in and that nobody changed for `ageMs`. A session with a
    // player on the page stays, so an open page never loses its game. Returns the codes it deleted.
    pruneEmpty: (ageMs: number) =>
      serialized(async () => {
        const cutoff = toEpochMs(now() - ageMs);
        const old = await rows(
          'FROM sessions SELECT code, doc::JSON AS doc WHERE updated_at < make_timestamptz($cutoff * 1000)',
          { cutoff },
          { code: codeColumn, doc: json },
        );
        const deleted: Code[] = [];
        for (const row of old) {
          const { code } = row;
          const doc = parseDoc(row.doc);
          const live = (await audience(code, doc)).presence;
          if (live.X || live.O || !core.isEmptySession(doc)) continue;
          await db.run('DELETE FROM sessions WHERE code = $code', { code });
          deleted.push(code);
        }
        return deleted;
      }),

    // The deletion notices since `since` (epoch ms), and the server time of the answer for the next call.
    deletedSince: (since: EpochMs): Promise<{ people: PersonId[]; until: EpochMs }> =>
      serialized(async () => {
        const until = now();
        const found = await rows(
          'FROM deleted_people SELECT person WHERE deleted_at >= make_timestamptz($since * 1000) AND deleted_at < make_timestamptz($until * 1000) ORDER BY person',
          { since, until },
          { person: personColumn },
        );
        return { people: found.map((row) => row.person), until };
      }),

    // Retention: reports, the moderation log and page faults after REPORTS_KEPT_MS, and deletion
    // notices after DELETION_NOTICES_KEPT_MS. Returns how many rows went from each table.
    pruneOld: (): Promise<Record<'reports' | 'moderation_log' | 'events' | 'deleted_people', number>> =>
      serialized(async () => {
        const prune = async (sql: string, ageMs: number) => (await rows(sql, { cutoff: toEpochMs(now() - ageMs) }, { n: int })).length;
        return {
          reports: await prune('DELETE FROM reports WHERE created_at < make_timestamptz($cutoff * 1000) RETURNING 1 AS n', REPORTS_KEPT_MS),
          moderation_log: await prune('DELETE FROM moderation_log WHERE created_at < make_timestamptz($cutoff * 1000) RETURNING 1 AS n', REPORTS_KEPT_MS),
          events: await prune('DELETE FROM events WHERE created_at < make_timestamptz($cutoff * 1000) RETURNING 1 AS n', REPORTS_KEPT_MS),
          deleted_people: await prune('DELETE FROM deleted_people WHERE deleted_at < make_timestamptz($cutoff * 1000) RETURNING 1 AS n', DELETION_NOTICES_KEPT_MS),
        };
      }),

    // Waits for the running work of both connections: closing a connection under a running query crashes the process.
    async close(): Promise<void> {
      closing = true;
      await Promise.all([readQueue, queue]);
      reader.closeSync();
      db.closeSync();
      instance.closeSync();
    },
  };
}

export type Store = Awaited<ReturnType<typeof openStore>>;

import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { type DuckDBValue, DuckDBInstance, listValue } from '@duckdb/node-api';
import { DIFFICULTIES } from '../src/ai.ts';
import { NO_LIMIT, type TimeControl } from '../src/clock.ts';
import { type EpochMs, MAX_EPOCH_MS, epochNow, toEpochMs } from '../src/epoch.ts';
import { type LineKind, type Player, lineKind, other, winnerOf } from '../src/game.ts';
import { nameOf } from '../src/names.ts';
import {
  ACCOUNT_TOKEN_PREFIX,
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
  type Stats,
  type StatsFilter,
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
  toGame,
} from '../src/protocol.ts';
import { type Records, addLoss } from '../src/records.ts';
import * as core from '../src/session/core.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from '../src/session/format.ts';
import type { PlayoffRequest } from '../src/practice/playoff.ts';
import type { PracticeBoard, PracticeMode, PracticeRun, PresetId } from '../src/practice/practice.ts';
import { DELETED_NAME } from '../src/deletions.ts';
import type { Release } from '../src/release.ts';
import { DATA_TABLES, type DeletedData } from './api-docs.ts';
import { practiceBoard, practiceStats } from './practice.ts';
import { type Rows, bigId, bool, code as codeColumn, deviceGameId, epoch, gameId, int, json, nullable, oneOf, readRow, text } from './sql.ts';
import { computeStats, SEAT_O, SEAT_X } from './stats.ts';

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
  // GitHub accounts. The id is GitHub's, which stays the same when a player renames the account.
  `CREATE TABLE IF NOT EXISTS users (
     github_id BIGINT PRIMARY KEY,
     login VARCHAR NOT NULL,
     avatar VARCHAR NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The devices of an account. A token is the random id one browser keeps.
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
  // the history without a link (see SEAT_X below for how the queries read them).
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
  // Reports of a chat message or a person. The text and the name are copies from the time of the
  // report, because the chat keeps only the newest messages. `reporter` is a token: never send it.
  'CREATE SEQUENCE IF NOT EXISTS report_order',
  `CREATE TABLE IF NOT EXISTS reports (
     id BIGINT PRIMARY KEY DEFAULT nextval('report_order'),
     code VARCHAR NOT NULL,
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
];

// The token that a seat holds when a logged-in player takes it. The account has a player_tokens row
// for it (ensureAccountRow), so the joins through player_tokens resolve an account seat to its user.
// The row comes before any seat names the token: at the login, and again before a seat or a logout uses it. Every device of the account holds it
// through identityOf, and a device that logs out does not. It passes the token checks of a stored
// document, so the format does not change. asPlayerToken refuses it as an X-Player value.
const accountToken = (githubId: number | bigint): string => `${ACCOUNT_TOKEN_PREFIX}${String(githubId).padStart(16, '0')}`;

export type GitHubUser = { id: number; login: string; avatar: string };

// A stored report as a maintainer reads it (GET /api/reports). It holds person ids, never a token.
export type StoredReport = {
  id: number;
  code: Code;
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

// Every write passes the same check as every read, so the table never holds a document that cannot
// be read back. This replaces the column CHECK constraints that a document column cannot have.
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
// The stats page asks often; the numbers change slowly.
const STATS_CACHE_MS = 60_000;

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

// The account of a seat from a LEFT JOIN of users: no login means no account.
function accountOf(login: string | null, avatar: string | null): PlayerInfo | null {
  if (login === null) return null;
  if (avatar === null) throw new Error('a stored account has no avatar');
  return { login, avatar };
}

// True for the result of a Nearby guest when the host's result of the same game names the guest.
// Both devices send a result, so the guest's history then lists the host's row only: it knows both players.
// The two copies can differ in the time of the last move by some milliseconds, so the match uses the
// moves and a finish within 10 minutes. Two games of the same two players with the same moves inside
// 10 minutes then count as one. Revisit this if a result ever carries a shared game id from the host.
const HOST_HAS_GAME = `(results.metrics.nearby.role::VARCHAR = 'guest' AND EXISTS (
  FROM results host SELECT 1
  WHERE host.doc.mode::VARCHAR = 'nearby' AND host.metrics.nearby.role::VARCHAR = 'host'
    AND results.token IN (host.player_x, host.player_o) AND host.token <> results.token
    AND host.doc.game.moves::INTEGER[] = results.doc.game.moves::INTEGER[]
    AND abs(epoch_ms(host.finished_at) - epoch_ms(results.finished_at)) < 600000))`;

// Joins the GitHub account of each seat of a result row: x_login, x_avatar, o_login, o_avatar.
const SEAT_ACCOUNTS = `
  LEFT JOIN player_tokens tx ON tx.token = ${SEAT_X} LEFT JOIN users ux ON ux.github_id = tx.github_id
  LEFT JOIN player_tokens t_o ON t_o.token = ${SEAT_O} LEFT JOIN users uo ON uo.github_id = t_o.github_id`;
const SEAT_ACCOUNT_COLUMNS = 'ux.login AS x_login, ux.avatar AS x_avatar, uo.login AS o_login, uo.avatar AS o_avatar';
// The shape of SEAT_ACCOUNT_COLUMNS, and of the seat tokens (SEAT_X AS token_x, SEAT_O AS token_o).
// A seat token is null for a seat without a known player.
const SEAT_SHAPE = {
  x_login: nullable(text),
  x_avatar: nullable(text),
  o_login: nullable(text),
  o_avatar: nullable(text),
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
  const db = await instance.connect();
  for (const statement of SCHEMA) await db.run(statement);

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

  async function loadRaw(code: Code): Promise<Row> {
    const [row] = await rows('FROM sessions SELECT doc::JSON AS doc, version WHERE code = $code', { code }, { doc: json, version: int });
    if (row === undefined) throw new SessionError(404, `No game with code ${code}.`);
    const stored = row.doc;
    const format = typeof stored === 'object' && stored !== null && 'format' in stored ? stored.format : undefined;
    return { code, doc: parseDoc(stored), version: row.version, stale: format !== CURRENT_FORMAT };
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
      `INSERT INTO results (id, token, doc, finished_at, public_id, player_x, player_o, winner, ending, line, metrics)
       VALUES ($id, $token, $doc::JSON::VARIANT, make_timestamptz($finished * 1000), $publicId, $x, $o, $winner, $ending, $line, $metrics::JSON::VARIANT)
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
    await db.run(
      'UPDATE sessions SET doc = $doc::JSON::VARIANT, version = version + 1, updated_at = now() WHERE code = $code',
      { code: row.code, doc: serialize(doc) },
    );
    // Only the live game can end, by a move or by a timeout.
    const index = doc.games.length - 1;
    const live = doc.games[index];
    const before = row.doc.games[index];
    if (doc.mode === 'online' && live !== undefined && isFinished(live) && !(before !== undefined && isFinished(before))) {
      await recordOnline(row.code, doc, index, live.timedOut ? now() : (live.times.at(-1) ?? now()));
    }
    onChange(row.code);
    return loadRaw(row.code);
  }

  // Loads a session, records a timeout that happened since the last write, and writes a document
  // in an older format back in the current format.
  async function load(code: Code): Promise<Row> {
    const row = await loadRaw(code);
    const settled = core.settle(row.doc, now());
    if (settled !== undefined) return save(row, settled);
    return row.stale ? save(row, row.doc) : row;
  }

  // Adds the player_tokens row of an account token, for an account that linked before account seats.
  async function ensureAccountRow(githubId: number | bigint): Promise<string> {
    const account = accountToken(githubId);
    await db.run('INSERT INTO player_tokens (token, github_id) VALUES ($token, $id) ON CONFLICT (token) DO NOTHING', {
      token: account,
      id: githubId,
    });
    return account;
  }

  // The token that a new seat of this device holds: the account token when the device is logged in.
  async function seatTokenOf(token: PlayerToken): Promise<string> {
    const [linked] = await rows('FROM player_tokens SELECT github_id WHERE token = $token', { token }, { github_id: bigId });
    return linked === undefined ? token : ensureAccountRow(linked.github_id);
  }

  // The token plus the tokens of the same GitHub account (the account token among them), so a
  // logged-in player holds their seats on every device.
  async function identityOf(token: PlayerToken | undefined): Promise<core.Identity> {
    if (token === undefined) return new Set();
    const linked = await rows(
      `FROM player_tokens SELECT token, github_id
       WHERE github_id = (FROM player_tokens SELECT github_id WHERE token = $token)`,
      { token },
      { token: text, github_id: bigId },
    );
    // The account token counts also before its own row exists (an account that linked before account seats).
    const account = linked[0] === undefined ? [] : [accountToken(linked[0].github_id)];
    return new Set([token, ...account, ...linked.map((row) => row.token)]);
  }

  async function playersOf(doc: SessionDoc): Promise<Record<Player, PlayerInfo | null>> {
    const seatTokens = [doc.seats.X, doc.seats.O].filter((token) => token !== null);
    if (seatTokens.length === 0) return { X: null, O: null };
    const found = await rows(
      `FROM player_tokens JOIN users USING (github_id) SELECT token, login, avatar
       WHERE list_contains($tokens, token)`,
      { tokens: listValue(seatTokens) },
      { token: text, login: text, avatar: text },
    );
    const info = (token: string | null): PlayerInfo | null => {
      const match = found.find((row) => row.token === token);
      return match === undefined ? null : { login: match.login, avatar: match.avatar };
    };
    return { X: info(doc.seats.X), O: info(doc.seats.O) };
  }

  // The token that stands for a person: the account token of a linked device, else the token itself.
  // Blocks and person ids use it, so they follow a logged-in account across devices.
  async function canonical(tokens: readonly string[]): Promise<Map<string, string>> {
    const known = [...new Set(tokens)];
    const linked =
      known.length === 0
        ? []
        : await rows('FROM player_tokens SELECT token, github_id WHERE list_contains($tokens, token)', { tokens: listValue(known) }, { token: text, github_id: bigId });
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
  // DuckDB's sha256 finds the token behind the person id, as in clearPersonName.
  // Limit: the device search hashes every seat token of every result. Revisit this when a person filter
  // takes more than about 100 ms: then keep the person id of each seat in a column.
  async function statsPersonOf(person: PersonId): Promise<{ tokens: string[]; shown: StatsPerson } | undefined> {
    const [account] = await rows(
      `FROM (SELECT DISTINCT github_id FROM player_tokens) LEFT JOIN users USING (github_id) SELECT github_id, login, avatar
       WHERE left(sha256($prefix || $account || lpad(github_id::VARCHAR, 16, '0')), ${PERSON_ID_LENGTH}) = $person`,
      { prefix: PERSON_ID_PREFIX, account: ACCOUNT_TOKEN_PREFIX, person },
      { github_id: bigId, login: nullable(text), avatar: nullable(text) },
    );
    if (account !== undefined) {
      const owner = accountToken(account.github_id);
      const linked = await rows('FROM player_tokens SELECT token WHERE github_id = $id', { id: account.github_id }, { token: text });
      const player = account.login === null || account.avatar === null ? null : { login: account.login, avatar: account.avatar };
      const name = player?.login ?? (await namesOf([owner]))(owner);
      return { tokens: [owner, ...linked.map((row) => row.token)], shown: { name, player } };
    }
    // A device without an account. A linked token stands for its account, so it is not a device person.
    const [device] = await rows(
      `SELECT DISTINCT seat AS token FROM (SELECT unnest([${SEAT_X}, ${SEAT_O}]) AS seat FROM results)
       WHERE seat IS NOT NULL AND seat <> $computer AND seat NOT IN (FROM player_tokens SELECT token)
         AND left(sha256($prefix || seat), ${PERSON_ID_LENGTH}) = $person
       LIMIT 1`,
      { prefix: PERSON_ID_PREFIX, person, computer: core.COMPUTER_TOKEN },
      { token: text },
    );
    if (device === undefined) return undefined;
    return { tokens: [device.token], shown: { name: (await namesOf([device.token]))(device.token), player: null } };
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
  // A GitHub login goes before both, through `players` or `player` in the view.
  async function namesOf(tokens: readonly (string | null)[]): Promise<core.NameOf> {
    const known = [...new Set(tokens.filter((token): token is string => token !== null && token !== core.COMPUTER_TOKEN))];
    const found =
      known.length === 0
        ? []
        : await rows('FROM player_names SELECT token, name WHERE list_contains($tokens, token)', { tokens: listValue(known) }, { token: text, name: text });
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
        : await rows(
            `FROM player_tokens a JOIN player_tokens b USING (github_id) JOIN users u USING (github_id)
             SELECT a.token AS token, b.token AS linked, u.github_id, u.login, u.avatar WHERE list_contains($tokens, a.token)`,
            { tokens: listValue(tokens) },
            { token: text, linked: text, github_id: bigId, login: text, avatar: text },
          );
    const presence = { X: false, O: false };
    const watchers: core.OpenWatcher[] = [];
    const logins = new Set<string>();
    for (const token of tokens) {
      const own = linked.filter((row) => row.token === token);
      const seats = core.seatsOf(doc, new Set([token, ...own.map((row) => row.linked)]));
      for (const seat of seats) presence[seat] = true;
      if (seats.length > 0) continue;
      const account = own[0];
      const player = account === undefined ? null : { login: account.login, avatar: account.avatar };
      if (player !== null && logins.has(player.login)) continue;
      if (player !== null) logins.add(player.login);
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
        if (watcher.token.startsWith(ACCOUNT_TOKEN_PREFIX)) await ensureAccountRow(BigInt(watcher.token.slice(ACCOUNT_TOKEN_PREFIX.length)));
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

  // Everyone answers by filter query (statsQuery). The filters have a few dozen combinations, so the map stays small.
  const statsCache = new Map<string, Stats>();

  // Delete my data: deletes or anonymises every row of this player, on every linked device, in one
  // transaction. A second call finds nothing and returns zero counts. Per table:
  // - sessions: the player's seats and seat request go, and the player's chat messages lose their
  //   text. A session that has no player and no move after that goes.
  // - results: a game that the player uploaded goes. An online game with another player stays for
  //   that player, and so does another player's upload: the player's seat becomes null.
  // - seat_metrics of the player's seats, player_names, the player's own blocks, private_stats, practice_runs: deleted.
  // - reports: a report about the player stays for moderation. A report that the player filed loses its reporter.
  // - player_tokens and users: the account goes, so no device acts for it any more.
  // Limit: a device of the account that is still logged in links itself again on its next visit,
  // because its login cookie stays valid. That account then starts empty. Revisit this if the
  // server ever keeps login sessions that it can end.
  // Limit: the session query reads every session document, like myGames. Revisit it at the same size.
  // `token` is a device token, or the account token of a maintainer request (deleteDataOf).
  async function deleteFor(token: PlayerToken): Promise<DeletedData> {
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
        await db.run('UPDATE sessions SET doc = $doc::JSON::VARIANT, version = version + 1, updated_at = now() WHERE code = $code', {
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
        `DELETE FROM results WHERE (list_contains($ids, token) AND doc.mode::VARCHAR IS DISTINCT FROM 'online')
           OR (doc.mode::VARCHAR = 'online' AND (list_contains($ids, player_x) OR list_contains($ids, player_o))
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
      // A block of this player by another player stays for that player, without the name.
      counts.blocks.anonymised = (
        await changedIds('UPDATE blocks SET name = $name WHERE list_contains($persons, person) AND name <> $name RETURNING owner || person AS id', { persons, name: DELETED_NAME })
      ).length;
      counts.practice_runs.deleted = (await changedIds('DELETE FROM practice_runs WHERE list_contains($ids, token) RETURNING id', { ids })).length;
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
      }
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    for (const code of changed) onChange(code);
    return counts;
  }

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create: (token: PlayerToken, name: string, clock: TimeControl = NO_LIMIT): Promise<SessionView> =>
      serialized(async () => {
        const doc = core.createDoc({ name, mode: 'online', clock, seats: { X: await seatTokenOf(token), O: null } });
        for (let attempt = 0; attempt < 20; attempt++) {
          const code = newCode();
          try {
            await db.run('INSERT INTO sessions (code, doc) VALUES ($code, $doc::JSON::VARIANT)', { code, doc: serialize(doc) });
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

    // The custom name of a player without a GitHub login, or null. `name` passed parseCustomName.
    customName: (token: PlayerToken): Promise<string | null> =>
      serialized(async () => {
        const [row] = await rows('FROM player_names SELECT name WHERE token = $token', { token }, { name: text });
        return row?.name ?? null;
      }),
    // Refuses a name that equals a known GitHub login, so nobody can pose as a logged-in player.
    // Limit: a GitHub account that logs in later with the same login does not rename the player.
    // Revisit this if two players with one name confuse people in practice.
    setName: (token: PlayerToken, name: string): Promise<void> =>
      serialized(async () => {
        const [clash] = await rows('FROM users SELECT login WHERE lower(login) = lower($name)', { name }, { login: text });
        if (clash !== undefined) throw new SessionError(409, 'That name is a GitHub login. Choose another name.');
        await db.run(
          `INSERT INTO player_names (token, name) VALUES ($token, $name)
           ON CONFLICT (token) DO UPDATE SET name = excluded.name, updated_at = now()`,
          { token, name },
        );
      }),
    clearName: (token: PlayerToken): Promise<void> =>
      serialized(async () => {
        await db.run('DELETE FROM player_names WHERE token = $token', { token });
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
    report: (token: PlayerToken, request: ReportRequest): Promise<{ id: number }> =>
      serialized(async () => {
        const row = await load(request.code);
        const { watchers } = await audience(row.code, row.doc);
        const everyone = [row.doc.seats.X, row.doc.seats.O, ...watchers.map((watcher) => watcher.token)];
        const person = await personsOf(everyone);
        const name = await namesOf(everyone);
        const reporter = await ownerOf(token);
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
        const [stored] = await rows(
          `INSERT INTO reports (code, message, message_text, person, person_name, reason, note, reporter, reporter_person)
           VALUES ($code, $message, $text, $person, $name, $reason, $note, $reporter, $reporterPerson) RETURNING id`,
          { code: row.code, ...target, reason: request.reason, note: request.note, reporter, reporterPerson: await personId(reporter) },
          { id: int },
        );
        if (stored === undefined) throw new Error('a report insert returned no id');
        return { id: stored.id };
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
            code: codeColumn,
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

    // A maintainer clears the custom name of a person. Returns the tokens that lost a name, so the
    // HTTP layer tells their open sessions. DuckDB's sha256 finds the token behind the person id.
    clearNameOf: (person: PersonId, login: string): Promise<string[]> =>
      serialized(async () => {
        const cleared = await rows(
          `DELETE FROM player_names WHERE left(sha256($prefix || token), ${PERSON_ID_LENGTH}) = $person RETURNING token`,
          { prefix: PERSON_ID_PREFIX, person },
          { token: text },
        );
        if (cleared.length === 0) throw new SessionError(404, 'That person has no custom name.');
        await logModeration(login, 'clear-name', { person });
        return cleared.map((row) => row.token);
      }),

    // Links this browser to a GitHub account, and refreshes the account's name and picture.
    linkToken: (token: PlayerToken, user: GitHubUser): Promise<void> =>
      serialized(async () => {
        await db.run(
          `INSERT INTO users (github_id, login, avatar) VALUES ($id, $login, $avatar)
           ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar = excluded.avatar, seen_at = now()`,
          { id: user.id, login: user.login, avatar: user.avatar },
        );
        await db.run(
          `INSERT INTO player_tokens (token, github_id) VALUES ($token, $id)
           ON CONFLICT (token) DO UPDATE SET github_id = excluded.github_id, linked_at = now()`,
          { token, id: user.id },
        );
        await ensureAccountRow(user.id);
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
          'FROM sessions SELECT code WHERE doc.seats.X::VARCHAR = $token OR doc.seats.O::VARCHAR = $token',
          { token },
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
             ${SEAT_X} AS token_x, ${SEAT_O} AS token_o
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
          players: { X: accountOf(row.x_login, row.x_avatar), O: accountOf(row.o_login, row.o_avatar) },
          names: await seatNames(row.token_x, row.token_o),
          finishedAt: row.finished,
        });
      }),

    // The finished games of this player in every mode, on all their linked devices, newest first.
    history: (token: PlayerToken, offset: number): Promise<HistoryPage> =>
      serialized(async () => {
        if (!Number.isInteger(offset) || offset < 0) throw new SessionError(400, 'The offset is not a whole number of games.');
        const tokens = listValue([...(await identityOf(token))]);
        // A seat that its player cleared (clearHistory) is not in the history.
        const found = await rows(
          `FROM results ${SEAT_ACCOUNTS}
           SELECT results.public_id, results.doc.mode::VARCHAR AS mode, results.doc.difficulty::VARCHAR AS difficulty,
             results.winner, results.ending, CASE WHEN results.ending IS NULL THEN results.doc::JSON END AS old_doc,
             len(results.doc.game.moves::INTEGER[]) AS moves, epoch_ms(results.finished_at) AS finished,
             coalesce(list_contains($tokens, ${SEAT_X}), false) AS mine_x,
             coalesce(list_contains($tokens, ${SEAT_O}), false) AS mine_o, ${SEAT_ACCOUNT_COLUMNS},
             ${SEAT_X} AS token_x, ${SEAT_O} AS token_o
           WHERE ((list_contains($tokens, ${SEAT_X}) AND results.hidden_x IS NOT TRUE)
              OR (list_contains($tokens, ${SEAT_O}) AND results.hidden_o IS NOT TRUE))
             AND NOT ${HOST_HAS_GAME}
           ORDER BY results.finished_at DESC, results.id
           LIMIT $limit OFFSET $offset`,
          { tokens, limit: HISTORY_PAGE_SIZE + 1, offset },
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
            opponent: you === 'X' ? accountOf(row.o_login, row.o_avatar) : you === 'O' ? accountOf(row.x_login, row.x_avatar) : null,
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
        const tokens = listValue([...(await identityOf(token))]);
        // A cleared game still counts: a record is a best value per setup, not a history entry.
        // The replay below also reads rows from before game links, which have no winner column.
        const found = await rows(
          `FROM results SELECT doc::JSON AS doc
           WHERE doc.mode::VARCHAR = 'computer' AND (list_contains($tokens, ${SEAT_X}) OR list_contains($tokens, ${SEAT_O}))`,
          { tokens },
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

    // Hides every finished game of this player from their history, on all linked devices.
    // The other seat of a shared game keeps it, and the stats and survival records still count it.
    // Returns how many seats it hid.
    clearHistory: (token: PlayerToken): Promise<number> =>
      serialized(async () => {
        const tokens = listValue([...(await identityOf(token))]);
        let hidden = 0;
        for (const [column, seat] of [['hidden_x', SEAT_X], ['hidden_o', SEAT_O]] as const) {
          const changed = await rows(
            `UPDATE results SET ${column} = true WHERE list_contains($tokens, ${seat}) AND ${column} IS NOT TRUE RETURNING id`,
            { tokens },
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
          const [user] = await rows('FROM users SELECT github_id WHERE lower(login) = lower($login)', { login: target.login }, { github_id: bigId });
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
          `INSERT INTO seat_metrics (public_id, seat, metrics) VALUES ($id, $seat, $metrics::JSON::VARIANT)
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

    addEvent: (event: ClientEvent): Promise<void> =>
      serialized(async () => {
        await db.run('INSERT INTO events (kind, message, version) VALUES ($kind, $message, $version)', event);
      }),

    // The aggregates of the stats page. An Everyone answer is at most STATS_CACHE_MS old. A Mine answer
    // (`token` is the player) and a person answer have no cache, so a game shows at once.
    // A person filter answers 403 when that person hides their stats, except to the person.
    // Limit: each Mine or person call runs all queries. Revisit this when such a call takes more than about 200 ms.
    stats: (filter: StatsFilter = ALL_STATS, token: PlayerToken | null = null): Promise<Stats> =>
      serialized(async () => {
        if (filter.scope === 'mine') {
          if (token === null) throw new SessionError(400, 'Your stats need the X-Player header.');
          return { ...(await computeStats(rows, now(), filter, [...(await identityOf(token))])), person: null, practice: await practiceStats(rows) };
        }
        if (filter.person !== null) {
          const hidden = await privateOwnerOf(filter.person);
          if (hidden !== undefined && (token === null || (await ownerOf(token)) !== hidden)) throw new SessionError(403, STATS_PRIVATE_MESSAGE);
          const found = await statsPersonOf(filter.person);
          if (found === undefined) throw new SessionError(404, 'This player has no finished games yet.');
          return { ...(await computeStats(rows, now(), filter, found.tokens)), person: found.shown, practice: await practiceStats(rows) };
        }
        const key = statsQuery(filter);
        const cached = statsCache.get(key);
        if (cached !== undefined && now() - cached.generatedAt < STATS_CACHE_MS) return cached;
        const fresh = { ...(await computeStats(rows, now(), filter, null)), person: null, practice: await practiceStats(rows) };
        statsCache.set(key, fresh);
        return fresh;
      }),

    // Every session and result of this player, on all their linked devices.
    // Limit: the session query reads every document in the table, and other requests wait in the
    // queue meanwhile. Revisit this when the sessions table holds about 100,000 rows, or when this
    // call takes more than about 100 ms. A list of seat tokens in its own indexed table then helps.
    myGames: (token: PlayerToken): Promise<MyGames> =>
      serialized(async () => {
        const identity = await identityOf(token);
        const tokens = listValue([...identity]);
        const total = emptyTally();
        const byMode = Object.fromEntries(SESSION_MODES.map((mode) => [mode, emptyTally()])) as MyGames['byMode'];
        const byDifficulty = Object.fromEntries(DIFFICULTIES.map((level) => [level, emptyTally()])) as MyGames['byDifficulty'];

        const sessionRows = await rows(
          `FROM sessions SELECT code, doc::JSON AS doc, epoch_ms(updated_at) AS updated
           WHERE list_contains($tokens, doc.seats.X::VARCHAR) OR list_contains($tokens, doc.seats.O::VARCHAR)
           ORDER BY updated_at DESC`,
          { tokens },
          { code: codeColumn, doc: json, updated: epoch },
        );
        const sessions: SessionSummary[] = [];
        for (const row of sessionRows) {
          const doc = parseDoc(row.doc);
          const you = core.seatsOf(doc, identity)[0];
          if (you === undefined) continue;
          for (const [index, record] of doc.games.entries()) {
            const game = toGame(record);
            if (game.status.kind === 'playing') continue;
            const winner = winnerOf(game.status);
            // The seats rotate between games, so the seat of this player in that game can differ from now.
            const outcome = winner === null ? 'drawn' : winner === seatIn(doc.flipped, index, you) ? 'won' : 'lost';
            count(total, outcome);
            count(byMode.online, outcome);
          }
          const live = core.currentGame(doc);
          sessions.push({
            code: row.code,
            name: doc.name,
            games: doc.games.filter((record) => record.moves.length > 0).length,
            you,
            opponent: (await playersOf(doc))[other(you)],
            opponentName: core.seatName(doc.seats[other(you)], await namesOf([doc.seats[other(you)]])),
            yourTurn: live.status.kind === 'playing' && live.turn === you && doc.seats[other(you)] !== null,
            updatedAt: row.updated,
          });
        }

        // The online rows of results repeat the session games counted above, so they stay out.
        const resultRows = await rows(
          "FROM results SELECT doc::JSON AS doc WHERE list_contains($tokens, token) AND doc.mode::VARCHAR <> 'online'",
          { tokens },
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
          'FROM player_tokens JOIN users USING (github_id) SELECT login, avatar WHERE token = $token',
          { token },
          { login: text, avatar: text },
        );
        return {
          user: user ?? null,
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

    close(): void {
      db.closeSync();
      instance.closeSync();
    },
  };
}

export type Store = Awaited<ReturnType<typeof openStore>>;

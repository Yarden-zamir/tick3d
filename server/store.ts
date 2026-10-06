import { randomInt } from 'node:crypto';
import { type DuckDBValue, DuckDBInstance, listValue } from '@duckdb/node-api';
import { DIFFICULTIES } from '../src/ai.ts';
import { NO_LIMIT, type TimeControl } from '../src/clock.ts';
import { type LineKind, type Player, lineKind, other, winnerOf } from '../src/game.ts';
import {
  ACCOUNT_TOKEN_PREFIX,
  CODE_ALPHABET,
  CODE_LENGTH,
  type ClientEvent,
  type Code,
  type GameId,
  type GameRecord,
  HISTORY_PAGE_SIZE,
  type HistoryEntry,
  type HistoryPage,
  type Metrics,
  type MoveRequest,
  type MyGames,
  type PlayerInfo,
  type PlayerToken,
  type PublicGame,
  type ResultUpload,
  SESSION_MODES,
  type SessionMode,
  type SessionSummary,
  type SessionUpdate,
  type SessionView,
  type Stats,
  type Tally,
  isGameRecord,
  parseMatchOptions,
  newGameId,
  onlineGameId,
  outcomeOf,
  parseHistoryPage,
  parsePublicGame,
  parseResultUpload,
  toGame,
} from '../src/protocol.ts';
import { type Records, addLoss } from '../src/records.ts';
import * as core from '../src/session/core.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from '../src/session/format.ts';
import type { PlayoffRequest } from '../src/practice/playoff.ts';
import type { PracticeBoard, PracticeMode, PracticeRun, PresetId } from '../src/practice/practice.ts';
import { practiceBoard, practiceStats } from './practice.ts';
import { computeStats, SEAT_O, SEAT_X } from './stats.ts';

const { SessionError } = core;

// Each statement is idempotent and runs on every start, in order. To change a table, append a
// statement such as `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ... DEFAULT ...`. Never edit one.
// A session is a VARIANT document (see src/session/format.ts), so most format changes need no SQL at all.
// Only pruneEmpty deletes rows: sessions where no game has a move. Games and results have no limit until storage calls for one.
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
];

// The token that a seat holds when a logged-in player takes it. The account has a player_tokens row
// for it (ensureAccountRow), so the joins through player_tokens resolve an account seat to its user.
// The row comes before any seat names the token: at the login, and again before a seat or a logout uses it. Every device of the account holds it
// through identityOf, and a device that logs out does not. It passes the token checks of a stored
// document, so the format does not change. asPlayerToken refuses it as an X-Player value.
const accountToken = (githubId: number | bigint): string => `${ACCOUNT_TOKEN_PREFIX}${String(githubId).padStart(16, '0')}`;

export type GitHubUser = { id: number; login: string; avatar: string };

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

function readStored(json: unknown): StoredGame {
  const doc: unknown = JSON.parse(String(json));
  if (typeof doc === 'object' && doc !== null && 'mode' in doc && doc.mode === 'online') {
    const { game } = doc as Record<string, unknown>;
    // A game stored before hideCoordinates reads it as false.
    const options = parseMatchOptions((doc as Record<string, unknown>).options);
    if (!isGameRecord(game) || !isFinished(game) || options === undefined) throw new Error('a stored online game does not parse');
    return { mode: 'online', game, you: null, difficulty: null, options, tuned: false };
  }
  // The finish time was checked when the result arrived.
  const upload = parseResultUpload(doc, Infinity);
  if (upload === undefined) throw new Error('a stored result does not parse');
  return upload;
}

// The seat tokens of a result from a device. Its player holds `you`, or both seats in a friend game.
// A Nearby host also names the guest on the other seat.
const seatTokens = (token: string, you: Player | null, guest: string | null): Record<Player, string | null> => ({
  X: you === 'O' ? guest : token,
  O: you === 'X' ? guest : token,
});

// A seat token column of a result row: a token, or null for a seat without a known player.
function tokenOf(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error('a stored seat token is not text');
}

function accountOf(login: unknown, avatar: unknown): PlayerInfo | null {
  if (login === null) return null;
  if (typeof login !== 'string' || typeof avatar !== 'string') throw new Error('a stored account has no login or avatar');
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

type StoreOptions = {
  now?: () => number;
  // Which seats of a session have it open now. The HTTP layer knows; tests pass nothing.
  presence?: (code: Code) => Record<Player, boolean>;
  // Runs after every write to a session, also a write during a read (a timeout, a format upgrade).
  // The HTTP layer tells the open pages of the session to fetch it again.
  onChange?: (code: Code) => void;
};

export async function openStore(
  path: string,
  { now = Date.now, presence = () => ({ X: false, O: false }), onChange = () => undefined }: StoreOptions = {},
) {
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

  async function rows(sql: string, values: Record<string, DuckDBValue>): Promise<Record<string, unknown>[]> {
    return (await db.runAndReadAll(sql, values)).getRowObjectsJS();
  }

  async function loadRaw(code: Code): Promise<Row> {
    const [row] = await rows('FROM sessions SELECT doc::JSON AS doc, version WHERE code = $code', { code });
    if (row === undefined) throw new SessionError(404, `No game with code ${code}.`);
    if (typeof row.doc !== 'string' || typeof row.version !== 'number') throw new Error(`unexpected row shape for ${code}`);
    const stored: unknown = JSON.parse(row.doc);
    const format = typeof stored === 'object' && stored !== null && 'format' in stored ? stored.format : undefined;
    return { code, doc: parseDoc(stored), version: row.version, stale: format !== CURRENT_FORMAT };
  }

  type NewResult = {
    id: string;
    token: string;
    doc: object;
    finishedAt: number;
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
    );
    return inserted.length > 0;
  }

  // Records a finished game of an online session in `results`, so every mode has rows in one table.
  // A second call for the same game changes nothing.
  async function recordOnline(code: Code, doc: SessionDoc, index: number, finishedAt: number): Promise<void> {
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
    const [linked] = await rows('FROM player_tokens SELECT github_id WHERE token = $token', { token });
    return linked === undefined ? token : ensureAccountRow(linked.github_id as number | bigint);
  }

  // The token plus the tokens of the same GitHub account (the account token among them), so a
  // logged-in player holds their seats on every device.
  async function identityOf(token: PlayerToken | undefined): Promise<core.Identity> {
    if (token === undefined) return new Set();
    const linked = await rows(
      `FROM player_tokens SELECT token
       WHERE github_id = (FROM player_tokens SELECT github_id WHERE token = $token)`,
      { token },
    );
    return new Set([token, ...linked.map((row) => String(row.token))]);
  }

  async function playersOf(doc: SessionDoc): Promise<Record<Player, PlayerInfo | null>> {
    const seatTokens = [doc.seats.X, doc.seats.O].filter((token) => token !== null);
    if (seatTokens.length === 0) return { X: null, O: null };
    const found = await rows(
      `FROM player_tokens JOIN users USING (github_id) SELECT token, login, avatar
       WHERE list_contains($tokens, token)`,
      { tokens: listValue(seatTokens) },
    );
    const info = (token: string | null): PlayerInfo | null => {
      const match = found.find((row) => row.token === token);
      return match === undefined ? null : { login: String(match.login), avatar: String(match.avatar) };
    };
    return { X: info(doc.seats.X), O: info(doc.seats.O) };
  }

  async function view(row: Row, identity: core.Identity): Promise<SessionView> {
    return core.viewOf(row.doc, {
      code: row.code,
      version: row.version,
      identity,
      now: now(),
      presence: presence(row.code),
      players: await playersOf(row.doc),
    });
  }

  // Loads, applies one rule of the core, saves when it changed something, and returns the caller's view.
  function change(code: Code, token: PlayerToken, rule: (doc: SessionDoc, identity: core.Identity) => SessionDoc) {
    return serialized(async () => {
      const row = await load(code);
      const identity = await identityOf(token);
      const doc = rule(row.doc, identity);
      return view(doc === row.doc ? row : await save(row, doc), identity);
    });
  }

  // The finished game of an online id ("<CODE>-<n>") in its session, or a 404.
  async function finishedOnlineGame(id: GameId): Promise<{ row: Row; game: GameRecord }> {
    const notFound = new SessionError(404, 'No game with this link.');
    const [code, number] = id.split('-');
    if (code === undefined || number === undefined) throw notFound;
    let row: Row;
    try {
      row = await loadRaw(code as Code);
    } catch (error) {
      if (error instanceof SessionError) throw notFound;
      throw error;
    }
    const game = row.doc.games[Number(number) - 1];
    if (game === undefined || !isFinished(game)) throw notFound;
    return { row, game };
  }

  // An online game that ended before the server recorded games in `results` reads from its session.
  // The hide options are those of the session now: the session does not keep them per game.
  async function onlineGameFromSession(id: GameId): Promise<PublicGame> {
    const { row, game } = await finishedOnlineGame(id);
    return parsePublicGame({
      id,
      mode: 'online',
      game,
      options: row.doc.options,
      difficulty: null,
      tuned: false,
      computer: null,
      players: await playersOf(row.doc),
      names: { X: core.seatName(row.doc.seats.X), O: core.seatName(row.doc.seats.O) },
      finishedAt: game.times.at(-1) ?? now(),
    });
  }

  let statsCache: Stats | undefined;

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

    // The seats a token holds in a session, for presence. Empty for a watcher.
    seatsOf: (code: Code, token: PlayerToken): Promise<Player[]> =>
      serialized(async () => core.seatsOf((await loadRaw(code)).doc, await identityOf(token))),

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
    chat: (code: Code, token: PlayerToken, text: unknown) =>
      change(code, token, (doc, identity) => core.chat(doc, identity, text, now())),
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
        );
        return { stored: inserted.length > 0 };
      }),

    // The leaderboard of one mode and preset, and the best run of the caller on all linked devices.
    practiceBoard: (mode: PracticeMode, preset: PresetId, token: PlayerToken | undefined): Promise<PracticeBoard> =>
      serialized(async () => practiceBoard(rows, mode, preset, [...(await identityOf(token))])),

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
    // Limit: the query reads the seats of every session document, like myGames. Revisit this at about
    // 100,000 sessions, or when a logout takes more than about 100 ms.
    unlinkToken: (token: PlayerToken): Promise<void> =>
      serialized(async () => {
        const [linked] = await rows('FROM player_tokens SELECT github_id WHERE token = $token', { token });
        if (linked === undefined) return;
        const account = await ensureAccountRow(linked.github_id as number | bigint);
        const held = await rows(
          'FROM sessions SELECT code WHERE doc.seats.X::VARCHAR = $token OR doc.seats.O::VARCHAR = $token',
          { token },
        );
        for (const { code } of held) {
          const row = await loadRaw(code as Code);
          const seats = { X: row.doc.seats.X === token ? account : row.doc.seats.X, O: row.doc.seats.O === token ? account : row.doc.seats.O };
          await save(row, { ...row.doc, seats });
        }
        await db.run('DELETE FROM player_tokens WHERE token = $token', { token });
      }),

    // Stores finished games from a device. A result already stored (same id) is skipped, so a
    // device can send again after a lost answer. Returns how many results were new, and the
    // public id of each result that has another public id on the server than the device sent:
    // a result without one, or one whose id another game holds already.
    addResults: (token: PlayerToken, uploads: readonly unknown[]): Promise<{ stored: number; renamed: Record<string, GameId> }> =>
      serialized(async () => {
        const results = uploads.map((upload) => parseResultUpload(upload, now()));
        if (!results.every((result): result is ResultUpload => result !== undefined)) {
          throw new SessionError(400, 'A result is not a valid finished game.');
        }
        if (results.some((result) => result.guest === token)) throw new SessionError(400, 'The guest of a Nearby game needs its own player token.');
        let stored = 0;
        const renamed: Record<string, GameId> = {};
        for (const result of results) {
          const [existing] = await rows('FROM results SELECT public_id WHERE id = $id', { id: result.id });
          // A row from before game links has no public id. The device then keeps the id it has.
          if (existing !== undefined && existing.public_id === null) continue;
          let publicId = existing === undefined ? (result.publicId ?? newGameId()) : (String(existing.public_id) as GameId);
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
          names: { X: core.seatName(tokenOf(row.token_x)), O: core.seatName(tokenOf(row.token_o)) },
          finishedAt: Number(row.finished),
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
        );
        const games = found.slice(0, HISTORY_PAGE_SIZE).map((row): HistoryEntry => {
          // A friend game holds this player on both seats.
          const you: Player | null = row.mine_x === true && row.mine_o === true ? null : row.mine_x === true ? 'X' : 'O';
          // A row from before game links has no ending columns: replay its game.
          const winner =
            row.ending === null ? endingOf(readStored(row.old_doc).game).winner : row.winner === 'X' || row.winner === 'O' ? row.winner : null;
          return {
            // A row from before game links has no public id, so it has no link.
            id: row.public_id as GameId | null,
            mode: row.mode as SessionMode,
            difficulty: row.difficulty as HistoryEntry['difficulty'],
            result: outcomeOf(winner, you),
            moves: Number(row.moves),
            opponent: you === 'X' ? accountOf(row.o_login, row.o_avatar) : you === 'O' ? accountOf(row.x_login, row.x_avatar) : null,
            opponentName: you === 'X' ? core.seatName(tokenOf(row.token_o)) : you === 'O' ? core.seatName(tokenOf(row.token_x)) : null,
            finishedAt: Number(row.finished),
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
          );
          hidden += changed.length;
        }
        return hidden;
      }),

    // The metrics of one player's device for a finished online game. The first report per seat
    // counts, so a page that sends again changes nothing. Returns false for a repeat.
    addSeatMetrics: (id: GameId, token: PlayerToken, metrics: Metrics): Promise<boolean> =>
      serialized(async () => {
        if (!id.includes('-')) throw new SessionError(400, 'Only an online game takes metrics here. Other games send them with the result.');
        const { row } = await finishedOnlineGame(id);
        const seat = core.seatsOf(row.doc, await identityOf(token))[0];
        if (seat === undefined) throw new SessionError(403, 'Only the two players can send metrics for this game.');
        const inserted = await rows(
          `INSERT INTO seat_metrics (public_id, seat, metrics) VALUES ($id, $seat, $metrics::JSON::VARIANT)
           ON CONFLICT DO NOTHING RETURNING seat`,
          { id, seat, metrics: JSON.stringify(metrics) },
        );
        return inserted.length > 0;
      }),

    addEvent: (event: ClientEvent): Promise<void> =>
      serialized(async () => {
        await db.run('INSERT INTO events (kind, message, version) VALUES ($kind, $message, $version)', event);
      }),

    // The aggregates of the stats page, at most STATS_CACHE_MS old.
    stats: (): Promise<Stats> =>
      serialized(async () => {
        if (statsCache === undefined || now() - statsCache.generatedAt >= STATS_CACHE_MS) {
          statsCache = { ...(await computeStats(rows, now())), practice: await practiceStats(rows) };
        }
        return statsCache;
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
        );
        const sessions: SessionSummary[] = [];
        for (const row of sessionRows) {
          const doc = parseDoc(JSON.parse(String(row.doc)));
          const you = core.seatsOf(doc, identity)[0];
          if (you === undefined) continue;
          for (const record of doc.games) {
            const game = toGame(record);
            if (game.status.kind === 'playing') continue;
            const winner = winnerOf(game.status);
            const outcome = winner === null ? 'drawn' : winner === you ? 'won' : 'lost';
            count(total, outcome);
            count(byMode.online, outcome);
          }
          const live = core.currentGame(doc);
          sessions.push({
            code: row.code as Code,
            name: doc.name,
            games: doc.games.filter((record) => record.moves.length > 0).length,
            you,
            opponent: (await playersOf(doc))[other(you)],
            opponentName: core.seatName(doc.seats[other(you)]),
            yourTurn: live.status.kind === 'playing' && live.turn === you && doc.seats[other(you)] !== null,
            updatedAt: Number(row.updated),
          });
        }

        // The online rows of results repeat the session games counted above, so they stay out.
        const resultRows = await rows(
          "FROM results SELECT doc::JSON AS doc WHERE list_contains($tokens, token) AND doc.mode::VARCHAR <> 'online'",
          { tokens },
        );
        for (const row of resultRows) {
          const result = parseResultUpload(JSON.parse(String(row.doc)), now());
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
        );
        return {
          user: user === undefined ? null : { login: String(user.login), avatar: String(user.avatar) },
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
        const cutoff = now() - ageMs;
        const old = await rows('FROM sessions SELECT code, doc::JSON AS doc WHERE updated_at < make_timestamptz($cutoff * 1000)', {
          cutoff,
        });
        const deleted: Code[] = [];
        for (const row of old) {
          if (typeof row.code !== 'string' || typeof row.doc !== 'string') throw new Error('unexpected session row shape');
          const code = row.code as Code;
          const live = presence(code);
          if (live.X || live.O || !core.isEmptySession(parseDoc(JSON.parse(row.doc)))) continue;
          await db.run('DELETE FROM sessions WHERE code = $code', { code });
          deleted.push(code);
        }
        return deleted;
      }),

    close(): void {
      db.closeSync();
      instance.closeSync();
    },
  };
}

export type Store = Awaited<ReturnType<typeof openStore>>;

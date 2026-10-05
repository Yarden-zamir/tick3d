import { randomInt } from 'node:crypto';
import { type DuckDBValue, DuckDBInstance, listValue } from '@duckdb/node-api';
import { DIFFICULTIES } from '../src/ai.ts';
import { NO_LIMIT, type TimeControl } from '../src/clock.ts';
import { type Player, other, winnerOf } from '../src/game.ts';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  type MoveRequest,
  type MyGames,
  type PlayerInfo,
  type PlayerToken,
  type ResultUpload,
  SESSION_MODES,
  type SessionSummary,
  type SessionUpdate,
  type SessionView,
  type Tally,
  parseResultUpload,
  toGame,
} from '../src/protocol.ts';
import * as core from '../src/session/core.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from '../src/session/format.ts';

const { SessionError } = core;

// Each statement is idempotent and runs on every start, in order. To change a table, append a
// statement such as `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ... DEFAULT ...`. Never edit one.
// A session is a VARIANT document (see src/session/format.ts), so most format changes need no SQL at all.
// Nothing here deletes old rows: sessions, games and results have no limit until storage calls for one.
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
  // Finished games played away from the server: computer, friend and Nearby games.
  `CREATE TABLE IF NOT EXISTS results (
     id VARCHAR PRIMARY KEY,
     token VARCHAR NOT NULL,
     doc VARIANT NOT NULL,
     finished_at TIMESTAMPTZ NOT NULL,
     received_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

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

  async function save(row: Row, doc: SessionDoc): Promise<Row> {
    await db.run(
      'UPDATE sessions SET doc = $doc::JSON::VARIANT, version = version + 1, updated_at = now() WHERE code = $code',
      { code: row.code, doc: serialize(doc) },
    );
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

  // The token plus the tokens of the same GitHub account, so a logged-in player holds their seats on every device.
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

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create: (token: PlayerToken, name: string, clock: TimeControl = NO_LIMIT): Promise<SessionView> =>
      serialized(async () => {
        const doc = core.createDoc({ name, mode: 'online', clock, seats: { X: token, O: null } });
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

    join: (code: Code, token: PlayerToken) => change(code, token, (doc, identity) => core.join(doc, identity, token)),
    move: (code: Code, token: PlayerToken, request: MoveRequest) =>
      change(code, token, (doc, identity) => core.move(doc, identity, request, now())),
    newGame: (code: Code, token: PlayerToken) => change(code, token, core.newGame),
    update: (code: Code, token: PlayerToken, changes: SessionUpdate) =>
      change(code, token, (doc, identity) => core.update(doc, identity, changes)),
    lock: (code: Code, token: PlayerToken) => change(code, token, core.lock),
    chat: (code: Code, token: PlayerToken, text: unknown) =>
      change(code, token, (doc, identity) => core.chat(doc, identity, text, now())),

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
      }),

    // Logout: this browser no longer acts for its account. The other devices of the account stay linked.
    unlinkToken: (token: PlayerToken): Promise<void> =>
      serialized(async () => {
        await db.run('DELETE FROM player_tokens WHERE token = $token', { token });
      }),

    // Stores finished games from a device. A result already stored (same id) is skipped, so a
    // device can send again after a lost answer. Returns how many results were new.
    addResults: (token: PlayerToken, uploads: readonly unknown[]): Promise<number> =>
      serialized(async () => {
        const results = uploads.map((upload) => parseResultUpload(upload, now()));
        if (!results.every((result): result is ResultUpload => result !== undefined)) {
          throw new SessionError(400, 'A result is not a valid finished game.');
        }
        let stored = 0;
        for (const result of results) {
          const inserted = await rows(
            `INSERT INTO results (id, token, doc, finished_at)
             VALUES ($id, $token, $doc::JSON::VARIANT, make_timestamptz($finished * 1000))
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            { id: result.id, token, doc: JSON.stringify(result), finished: result.finishedAt },
          );
          stored += inserted.length;
        }
        return stored;
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
            yourTurn: live.status.kind === 'playing' && live.turn === you && doc.seats[other(you)] !== null,
            updatedAt: Number(row.updated),
          });
        }

        const resultRows = await rows('FROM results SELECT doc::JSON AS doc WHERE list_contains($tokens, token)', { tokens });
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

    close(): void {
      db.closeSync();
      instance.closeSync();
    },
  };
}

export type Store = Awaited<ReturnType<typeof openStore>>;

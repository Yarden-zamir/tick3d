import { randomInt } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { NO_LIMIT, type TimeControl, isFlagged } from '../src/clock.ts';
import { type Game, type Player, other, play, timeOut } from '../src/game.ts';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  type GameRecord,
  MAX_GAMES_PER_SESSION,
  MAX_SESSIONS,
  type MoveRequest,
  type PlayerToken,
  type SessionUpdate,
  type SessionView,
  normalizeName,
  toGame,
  toRecord,
} from '../src/protocol.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from './format.ts';

export class StoreError extends Error {
  status: 400 | 403 | 404 | 405 | 409;
  constructor(status: 400 | 403 | 404 | 405 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

// Each statement is idempotent and runs on every start, in order. To change the table, append a
// statement such as `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ... DEFAULT ...`. Never edit one.
// The session itself is a VARIANT document (see format.ts), so most format changes need no SQL at all.
const SCHEMA = [
  'CREATE SEQUENCE IF NOT EXISTS session_order',
  `CREATE TABLE IF NOT EXISTS sessions (
     code VARCHAR PRIMARY KEY CHECK (length(code) = ${CODE_LENGTH}),
     -- Creation order, so the oldest sessions go first when the table is full.
     seq BIGINT NOT NULL DEFAULT nextval('session_order'),
     doc VARIANT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

// `stale` marks a document stored in an older format. It is written back in the current format.
type Row = { code: Code; doc: SessionDoc; version: number; stale: boolean };

const emptyRecord = (clock: TimeControl): GameRecord => ({ moves: [], times: [], clock, timedOut: false });

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

function seatOf(doc: SessionDoc, player: PlayerToken | undefined): Player | null {
  if (player === undefined) return null;
  if (doc.seats.X === player) return 'X';
  if (doc.seats.O === player) return 'O';
  return null;
}

function currentGame(doc: SessionDoc): Game {
  const record = doc.games.at(-1);
  if (record === undefined) throw new Error('session has no games');
  return toGame(record);
}

function isLocked(doc: SessionDoc): boolean {
  return doc.lockedGame === doc.games.length - 1 && currentGame(doc).status.kind === 'playing';
}

function seated(doc: SessionDoc, player: PlayerToken | undefined): Player {
  const seat = seatOf(doc, player);
  if (seat === null) throw new StoreError(403, 'Only the two players can change this game.');
  return seat;
}

export async function openStore(path: string, maxSessions: number = MAX_SESSIONS, now: () => number = Date.now) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions must be >= 1: ${maxSessions}`);
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

  async function loadRaw(code: Code): Promise<Row> {
    const reader = await db.runAndReadAll('FROM sessions SELECT doc::JSON AS doc, version WHERE code = $code', { code });
    const [row] = reader.getRowObjectsJS();
    if (row === undefined) throw new StoreError(404, `No game with code ${code}.`);
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
    return loadRaw(row.code);
  }

  // Loads a session and records a timeout that happened since the last write. The result of a
  // flagged clock never depends on a page reporting it, so every read and write sees the same game.
  // A document in an older format is written back in the current format here, on first read.
  async function load(code: Code): Promise<Row> {
    const row = await loadRaw(code);
    const game = currentGame(row.doc);
    if (isFlagged(game, now())) {
      return save(row, { ...row.doc, games: [...row.doc.games.slice(0, -1), toRecord(timeOut(game))] });
    }
    return row.stale ? save(row, row.doc) : row;
  }

  function view(row: Row, player: PlayerToken | undefined): SessionView {
    const { doc } = row;
    return {
      code: row.code,
      name: doc.name,
      games: doc.games,
      seats: { X: doc.seats.X !== null, O: doc.seats.O !== null },
      you: seatOf(doc, player),
      options: doc.options,
      locked: isLocked(doc),
      clock: doc.clock,
      now: now(),
      version: row.version,
    };
  }

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create: (player: PlayerToken, name: string, clock: TimeControl = NO_LIMIT): Promise<SessionView> =>
      serialized(async () => {
        const validName = normalizeName(name);
        if (validName === undefined) throw new StoreError(400, 'A name needs 1 to 40 characters.');
        const doc: SessionDoc = {
          format: CURRENT_FORMAT,
          name: validName,
          games: [emptyRecord(clock)],
          seats: { X: player, O: null },
          options: { hideBoard: false, hideHistory: false },
          lockedGame: null,
          clock,
        };
        for (let attempt = 0; attempt < 20; attempt++) {
          const code = newCode();
          try {
            await db.run('INSERT INTO sessions (code, doc) VALUES ($code, $doc::JSON::VARIANT)', { code, doc: serialize(doc) });
          } catch (error) {
            if (error instanceof Error && error.message.includes('Duplicate key')) continue;
            throw error;
          }
          // Keep the newest sessions only. DuckDB 1.5 has no triggers; with DuckDB 2.0, move this into an AFTER INSERT trigger.
          await db.run(`DELETE FROM sessions WHERE code IN (SELECT code FROM sessions ORDER BY seq DESC OFFSET ${maxSessions})`);
          return view(await load(code), player);
        }
        throw new Error('could not find a free session code after 20 attempts');
      }),

    get: (code: Code, player: PlayerToken | undefined): Promise<SessionView> =>
      serialized(async () => view(await load(code), player)),

    join: (code: Code, player: PlayerToken): Promise<SessionView> =>
      serialized(async () => {
        const row = await load(code);
        const { seats } = row.doc;
        if (seatOf(row.doc, player) !== null) return view(row, player);
        if (seats.X === null) return view(await save(row, { ...row.doc, seats: { ...seats, X: player } }), player);
        if (seats.O === null) return view(await save(row, { ...row.doc, seats: { ...seats, O: player } }), player);
        throw new StoreError(409, 'Both seats are taken. You can watch this game.');
      }),

    move: (code: Code, player: PlayerToken, request: MoveRequest): Promise<SessionView> =>
      serialized(async () => {
        const row = await load(code);
        const seat = seated(row.doc, player);
        const { games } = row.doc;
        const game = currentGame(row.doc);
        // The client sends what it saw. A mismatch means another move landed first.
        if (request.game !== games.length - 1 || request.moveCount !== game.moves.length) {
          throw new StoreError(409, 'The board changed. It now shows the latest moves.');
        }
        if (game.status.kind === 'timeout') throw new StoreError(409, `Time is up. ${other(game.status.winner)} ran out of time.`);
        if (game.status.kind === 'playing' && game.turn !== seat) throw new StoreError(409, 'It is not your turn.');
        const result = play(game, request.cell, now());
        if (!result.ok) {
          throw new StoreError(409, result.error === 'occupied' ? 'That cell is taken.' : 'This game is over.');
        }
        return view(await save(row, { ...row.doc, games: [...games.slice(0, -1), toRecord(result.game)] }), player);
      }),

    newGame: (code: Code, player: PlayerToken): Promise<SessionView> =>
      serialized(async () => {
        const row = await load(code);
        seated(row.doc, player);
        if (currentGame(row.doc).status.kind === 'playing') throw new StoreError(409, 'Finish this game first.');
        if (row.doc.games.length >= MAX_GAMES_PER_SESSION) {
          throw new StoreError(409, `A session holds ${MAX_GAMES_PER_SESSION} games. Start a new code.`);
        }
        return view(await save(row, { ...row.doc, games: [...row.doc.games, emptyRecord(row.doc.clock)] }), player);
      }),

    // The name stays open during a lock. The match options and the clock do not.
    update: (code: Code, player: PlayerToken, changes: SessionUpdate): Promise<SessionView> =>
      serialized(async () => {
        const row = await load(code);
        seated(row.doc, player);
        const changesMatch = changes.hideBoard !== undefined || changes.hideHistory !== undefined || changes.clock !== undefined;
        if (changesMatch && isLocked(row.doc)) throw new StoreError(409, 'Settings are locked until this game ends.');
        const doc: SessionDoc = {
          ...row.doc,
          name: changes.name ?? row.doc.name,
          options: {
            hideBoard: changes.hideBoard ?? row.doc.options.hideBoard,
            hideHistory: changes.hideHistory ?? row.doc.options.hideHistory,
          },
          clock: changes.clock ?? row.doc.clock,
        };
        // A game keeps the limit it started with. A game without moves has not started yet.
        const live = doc.games.at(-1);
        if (changes.clock !== undefined && live !== undefined && live.moves.length === 0 && !live.timedOut) {
          doc.games = [...doc.games.slice(0, -1), emptyRecord(changes.clock)];
        }
        return view(await save(row, doc), player);
      }),

    // Locks the match options, and every screen's own settings, for both players until the live game ends.
    lock: (code: Code, player: PlayerToken): Promise<SessionView> =>
      serialized(async () => {
        const row = await load(code);
        seated(row.doc, player);
        if (isLocked(row.doc)) return view(row, player);
        if (currentGame(row.doc).status.kind !== 'playing') throw new StoreError(409, 'This game is over. Start a new game first.');
        return view(await save(row, { ...row.doc, lockedGame: row.doc.games.length - 1 }), player);
      }),

    close(): void {
      db.closeSync();
      instance.closeSync();
    },
  };
}

export type Store = Awaited<ReturnType<typeof openStore>>;

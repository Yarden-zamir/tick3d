import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { type Game, type Player, play, replay } from '../src/game.ts';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  MAX_GAMES_PER_SESSION,
  MAX_SESSIONS,
  NAME_MAX_LENGTH,
  type MoveRequest,
  type PlayerToken,
  type SessionView,
  isMoveList,
  normalizeName,
} from '../src/protocol.ts';

export class StoreError extends Error {
  status: 400 | 403 | 404 | 405 | 409;
  constructor(status: 400 | 403 | 404 | 405 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = {
  code: Code; // the table CHECK keeps codes at 4 characters
  name: string;
  games: string;
  seat_x: string | null;
  seat_o: string | null;
  version: number;
};

function isRow(value: unknown): value is Row {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.code === 'string' &&
    row.code.length === CODE_LENGTH &&
    typeof row.name === 'string' &&
    typeof row.games === 'string' &&
    (row.seat_x === null || typeof row.seat_x === 'string') &&
    (row.seat_o === null || typeof row.seat_o === 'string') &&
    typeof row.version === 'number'
  );
}

function schema(maxSessions: number): string {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions must be >= 1: ${maxSessions}`);
  return `
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY CHECK (length(code) = ${CODE_LENGTH}),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${NAME_MAX_LENGTH}),
      games TEXT NOT NULL CHECK (json_valid(games) AND json_type(games) = 'array'),
      seat_x TEXT,
      seat_o TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_created ON sessions (created_at);

    -- Keep the newest sessions only. The limit is part of the trigger, so recreate it on start.
    DROP TRIGGER IF EXISTS sessions_keep_newest;
    CREATE TRIGGER sessions_keep_newest AFTER INSERT ON sessions
    BEGIN
      DELETE FROM sessions WHERE code IN (
        SELECT code FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${maxSessions}
      );
    END;
  `;
}

function newCode(): Code {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('') as Code;
}

function seatOf(row: Row, player: PlayerToken | undefined): Player | null {
  if (player === undefined) return null;
  if (row.seat_x === player) return 'X';
  if (row.seat_o === player) return 'O';
  return null;
}

function parseGames(row: Row): number[][] {
  const games: unknown = JSON.parse(row.games);
  if (!Array.isArray(games) || games.length === 0 || !games.every(isMoveList)) {
    throw new Error(`stored games are not valid for session ${row.code}`);
  }
  return games;
}

function currentGame(games: number[][]): Game {
  const moves = games.at(-1);
  if (moves === undefined) throw new Error('session has no games');
  return replay(moves);
}

// node:sqlite is synchronous and Node runs one request handler at a time, so each
// read-check-write below is atomic without an explicit transaction.
// Revisit this if the API ever runs more than one process against the same file.
export function openStore(path: string, maxSessions: number = MAX_SESSIONS) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schema(maxSessions));

  const select = db.prepare('SELECT code, name, games, seat_x, seat_o, version FROM sessions WHERE code = ?');
  const insert = db.prepare(
    'INSERT INTO sessions (code, name, games, seat_x, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const update = db.prepare(
    'UPDATE sessions SET name = ?, games = ?, seat_x = ?, seat_o = ?, version = version + 1, updated_at = ? WHERE code = ?',
  );

  function load(code: Code): Row {
    const row: unknown = select.get(code);
    if (row === undefined) throw new StoreError(404, `No game with code ${code}.`);
    if (!isRow(row)) throw new Error(`unexpected row shape for session ${code}`);
    return row;
  }

  function save(row: Row, changes: Partial<Pick<Row, 'name' | 'games' | 'seat_x' | 'seat_o'>>): Row {
    const next = { ...row, ...changes };
    update.run(next.name, next.games, next.seat_x, next.seat_o, Date.now(), row.code);
    return load(row.code);
  }

  function view(row: Row, player: PlayerToken | undefined): SessionView {
    return {
      code: row.code,
      name: row.name,
      games: parseGames(row),
      seats: { X: row.seat_x !== null, O: row.seat_o !== null },
      you: seatOf(row, player),
      version: row.version,
    };
  }

  function seated(row: Row, player: PlayerToken | undefined): Player {
    const seat = seatOf(row, player);
    if (seat === null) throw new StoreError(403, 'Only the two players can change this game.');
    return seat;
  }

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create(player: PlayerToken, name: string): SessionView {
      const validName = normalizeName(name);
      if (validName === undefined) throw new StoreError(400, 'A name needs 1 to 40 characters.');
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = newCode();
        try {
          const now = Date.now();
          insert.run(code, validName, '[[]]', player, now, now);
          return view(load(code), player);
        } catch (error) {
          const duplicate = error instanceof Error && 'errcode' in error && error.errcode === 1555;
          if (!duplicate) throw error;
        }
      }
      throw new Error('could not find a free session code after 20 attempts');
    },

    get(code: Code, player: PlayerToken | undefined): SessionView {
      return view(load(code), player);
    },

    join(code: Code, player: PlayerToken): SessionView {
      const row = load(code);
      if (seatOf(row, player) !== null) return view(row, player);
      if (row.seat_x === null) return view(save(row, { seat_x: player }), player);
      if (row.seat_o === null) return view(save(row, { seat_o: player }), player);
      throw new StoreError(409, 'Both seats are taken. You can watch this game.');
    },

    move(code: Code, player: PlayerToken, request: MoveRequest): SessionView {
      const row = load(code);
      const seat = seated(row, player);
      const games = parseGames(row);
      const game = currentGame(games);
      // The client sends what it saw. A mismatch means another move landed first.
      if (request.game !== games.length - 1 || request.moveCount !== game.moves.length) {
        throw new StoreError(409, 'The board changed. It now shows the latest moves.');
      }
      if (game.status.kind === 'playing' && game.turn !== seat) throw new StoreError(409, 'It is not your turn.');
      const result = play(game, request.cell);
      if (!result.ok) {
        throw new StoreError(409, result.error === 'occupied' ? 'That cell is taken.' : 'This game is over.');
      }
      games[games.length - 1] = [...result.game.moves];
      return view(save(row, { games: JSON.stringify(games) }), player);
    },

    newGame(code: Code, player: PlayerToken): SessionView {
      const row = load(code);
      seated(row, player);
      const games = parseGames(row);
      if (currentGame(games).status.kind === 'playing') throw new StoreError(409, 'Finish this game first.');
      if (games.length >= MAX_GAMES_PER_SESSION) {
        throw new StoreError(409, `A session holds ${MAX_GAMES_PER_SESSION} games. Start a new code.`);
      }
      return view(save(row, { games: JSON.stringify([...games, []]) }), player);
    },

    rename(code: Code, player: PlayerToken, name: unknown): SessionView {
      const row = load(code);
      seated(row, player);
      const validName = normalizeName(name);
      if (validName === undefined) throw new StoreError(400, 'A name needs 1 to 40 characters.');
      return view(save(row, { name: validName }), player);
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;

import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LIMIT_RANGE, NO_LIMIT, type TimeControl, isFlagged, parseClock } from '../src/clock.ts';
import { type Game, type Player, other, play, timeOut } from '../src/game.ts';
import {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  type ChatMessage,
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  type GameRecord,
  MAX_GAMES_PER_SESSION,
  MAX_SESSIONS,
  NAME_MAX_LENGTH,
  type MoveRequest,
  type PlayerToken,
  type SessionUpdate,
  type SessionView,
  isGameRecord,
  isMoveList,
  normalizeChat,
  normalizeName,
  toGame,
  toRecord,
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
  hide_board: number;
  hide_history: number;
  locked_game: number | null;
  clock_move: number | null;
  clock_game: number | null;
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
    typeof row.hide_board === 'number' &&
    typeof row.hide_history === 'number' &&
    (row.locked_game === null || typeof row.locked_game === 'number') &&
    (row.clock_move === null || typeof row.clock_move === 'number') &&
    (row.clock_game === null || typeof row.clock_game === 'number') &&
    typeof row.version === 'number'
  );
}

const emptyRecord = (clock: TimeControl): GameRecord => ({ moves: [], times: [], clock, timedOut: false });

function schema(maxSessions: number): string {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions must be >= 1: ${maxSessions}`);
  const { perMove, perGame } = LIMIT_RANGE;
  return `
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY CHECK (length(code) = ${CODE_LENGTH}),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${NAME_MAX_LENGTH}),
      games TEXT NOT NULL CHECK (json_valid(games) AND json_type(games) = 'array'),
      seat_x TEXT,
      seat_o TEXT,
      hide_board INTEGER NOT NULL DEFAULT 0 CHECK (hide_board IN (0, 1)),
      hide_history INTEGER NOT NULL DEFAULT 0 CHECK (hide_history IN (0, 1)),
      -- Index of the game that the lock holds. The lock ends when that game ends.
      locked_game INTEGER CHECK (locked_game >= 0),
      -- The time limit for the next game, in seconds. NULL means no limit of that kind.
      clock_move INTEGER CHECK (clock_move BETWEEN ${perMove.min} AND ${perMove.max}),
      clock_game INTEGER CHECK (clock_game BETWEEN ${perGame.min} AND ${perGame.max}),
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

    -- Chat. A deleted session takes its messages with it (foreign keys are on for this connection).
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
      seat TEXT NOT NULL CHECK (seat IN ('X', 'O')),
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ${CHAT_MAX_LENGTH}),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_code ON messages (code, id);

    -- Keep the newest messages of each session only.
    DROP TRIGGER IF EXISTS messages_keep_newest;
    CREATE TRIGGER messages_keep_newest AFTER INSERT ON messages
    BEGIN
      DELETE FROM messages WHERE code = NEW.code AND id NOT IN (
        SELECT id FROM messages WHERE code = NEW.code ORDER BY id DESC LIMIT ${CHAT_KEEP}
      );
    END;
  `;
}

type MessageRow = { id: number; seat: Player; text: string; created_at: number };

function isMessageRow(value: unknown): value is MessageRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'number' &&
    (row.seat === 'X' || row.seat === 'O') &&
    typeof row.text === 'string' &&
    typeof row.created_at === 'number'
  );
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

function parseGames(row: Row): GameRecord[] {
  const games: unknown = JSON.parse(row.games);
  if (!Array.isArray(games) || games.length === 0 || !games.every(isGameRecord)) {
    throw new Error(`stored games are not valid for session ${row.code}`);
  }
  return games;
}

function clockOf(row: Row): TimeControl {
  const clock = parseClock({ perMove: row.clock_move, perGame: row.clock_game });
  if (clock === undefined) throw new Error(`stored clock is not valid for session ${row.code}`);
  return clock;
}

function currentGame(games: GameRecord[]): Game {
  const record = games.at(-1);
  if (record === undefined) throw new Error('session has no games');
  return toGame(record);
}

function isLocked(row: Row, games: GameRecord[]): boolean {
  return row.locked_game === games.length - 1 && currentGame(games).status.kind === 'playing';
}

// node:sqlite is synchronous and Node runs one request handler at a time, so each
// read-check-write below is atomic without an explicit transaction.
// Revisit this if the API ever runs more than one process against the same file.
export function openStore(path: string, maxSessions: number = MAX_SESSIONS, now: () => number = Date.now) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema(maxSessions));

  const select = db.prepare(
    `SELECT code, name, games, seat_x, seat_o, hide_board, hide_history, locked_game, clock_move, clock_game, version
     FROM sessions WHERE code = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO sessions (code, name, games, seat_x, clock_move, clock_game, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE sessions SET name = ?, games = ?, seat_x = ?, seat_o = ?, hide_board = ?, hide_history = ?, locked_game = ?,
     clock_move = ?, clock_game = ?, version = version + 1, updated_at = ? WHERE code = ?`,
  );

  const selectChat = db.prepare('SELECT id, seat, text, created_at FROM messages WHERE code = ? ORDER BY id');
  const insertChat = db.prepare('INSERT INTO messages (code, seat, text, created_at) VALUES (?, ?, ?, ?)');
  // A message changes the session for the event streams, so it moves the version on.
  const touch = db.prepare('UPDATE sessions SET version = version + 1, updated_at = ? WHERE code = ?');

  function chatOf(code: Code): ChatMessage[] {
    return selectChat.all(code).map((row) => {
      if (!isMessageRow(row)) throw new Error(`unexpected message row for session ${code}`);
      return { id: row.id, from: row.seat, text: row.text, at: row.created_at };
    });
  }

  function loadRaw(code: Code): Row {
    const row: unknown = select.get(code);
    if (row === undefined) throw new StoreError(404, `No game with code ${code}.`);
    if (!isRow(row)) throw new Error(`unexpected row shape for session ${code}`);
    return row;
  }

  // Loads a session and records a timeout that happened since the last write. The result of a
  // flagged clock never depends on a page reporting it, so every read and write sees the same game.
  function load(code: Code): Row {
    const row = loadRaw(code);
    const games = parseGames(row);
    const game = currentGame(games);
    if (!isFlagged(game, now())) return row;
    games[games.length - 1] = toRecord(timeOut(game));
    return save(row, { games: JSON.stringify(games) });
  }

  type Changes = Partial<Omit<Row, 'code' | 'version'>>;

  function save(row: Row, changes: Changes): Row {
    const next = { ...row, ...changes };
    update.run(
      next.name,
      next.games,
      next.seat_x,
      next.seat_o,
      next.hide_board,
      next.hide_history,
      next.locked_game,
      next.clock_move,
      next.clock_game,
      now(),
      row.code,
    );
    return loadRaw(row.code);
  }

  function view(row: Row, player: PlayerToken | undefined): SessionView {
    const games = parseGames(row);
    return {
      code: row.code,
      name: row.name,
      games,
      seats: { X: row.seat_x !== null, O: row.seat_o !== null },
      you: seatOf(row, player),
      options: { hideBoard: row.hide_board === 1, hideHistory: row.hide_history === 1 },
      locked: isLocked(row, games),
      clock: clockOf(row),
      now: now(),
      version: row.version,
      chat: chatOf(row.code),
    };
  }

  function seated(row: Row, player: PlayerToken | undefined): Player {
    const seat = seatOf(row, player);
    if (seat === null) throw new StoreError(403, 'Only the two players can change this game.');
    return seat;
  }

  return {
    // The creator takes seat X, so the creator moves first in the first game.
    create(player: PlayerToken, name: string, clock: TimeControl = NO_LIMIT): SessionView {
      const validName = normalizeName(name);
      if (validName === undefined) throw new StoreError(400, 'A name needs 1 to 40 characters.');
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = newCode();
        try {
          const time = now();
          const games = JSON.stringify([emptyRecord(clock)]);
          insert.run(code, validName, games, player, clock.perMove, clock.perGame, time, time);
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
      if (game.status.kind === 'timeout') throw new StoreError(409, `Time is up. ${other(game.status.winner)} ran out of time.`);
      if (game.status.kind === 'playing' && game.turn !== seat) throw new StoreError(409, 'It is not your turn.');
      const result = play(game, request.cell, now());
      if (!result.ok) {
        throw new StoreError(409, result.error === 'occupied' ? 'That cell is taken.' : 'This game is over.');
      }
      games[games.length - 1] = toRecord(result.game);
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
      return view(save(row, { games: JSON.stringify([...games, emptyRecord(clockOf(row))]) }), player);
    },

    // The name stays open during a lock. The match options and the clock do not.
    update(code: Code, player: PlayerToken, changes: SessionUpdate): SessionView {
      const row = load(code);
      seated(row, player);
      const games = parseGames(row);
      const changesMatch =
        changes.hideBoard !== undefined || changes.hideHistory !== undefined || changes.clock !== undefined;
      if (changesMatch && isLocked(row, games)) throw new StoreError(409, 'Settings are locked until this game ends.');
      const next: Changes = {};
      if (changes.name !== undefined) next.name = changes.name;
      if (changes.hideBoard !== undefined) next.hide_board = changes.hideBoard ? 1 : 0;
      if (changes.hideHistory !== undefined) next.hide_history = changes.hideHistory ? 1 : 0;
      if (changes.clock !== undefined) {
        next.clock_move = changes.clock.perMove;
        next.clock_game = changes.clock.perGame;
        // A game keeps the limit it started with. A game without moves has not started yet.
        const live = games.at(-1);
        if (live !== undefined && live.moves.length === 0 && !live.timedOut) {
          games[games.length - 1] = emptyRecord(changes.clock);
          next.games = JSON.stringify(games);
        }
      }
      return view(save(row, next), player);
    },

    // Locks the match options, and every screen's own settings, for both players until the live game ends.
    lock(code: Code, player: PlayerToken): SessionView {
      const row = load(code);
      seated(row, player);
      const games = parseGames(row);
      if (isLocked(row, games)) return view(row, player);
      if (currentGame(games).status.kind !== 'playing') throw new StoreError(409, 'This game is over. Start a new game first.');
      return view(save(row, { locked_game: games.length - 1 }), player);
    },

    chat(code: Code, player: PlayerToken, text: unknown): SessionView {
      const row = load(code);
      const seat = seated(row, player);
      const message = normalizeChat(text);
      if (message === undefined) throw new StoreError(400, `A message needs 1 to ${CHAT_MAX_LENGTH} characters.`);
      const time = now();
      insertChat.run(code, seat, message, time);
      touch.run(time, code);
      return view(load(code), player);
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;

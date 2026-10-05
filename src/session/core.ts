// The rules of a session, as pure functions over its document. The server, the page in offline
// play and a Nearby host all run these, so a rule changes in one place for every mode.
// No function here does I/O: each takes a document and returns a new one, or throws a SessionError.
import type { Difficulty } from '../ai.ts';
import { NO_LIMIT, type TimeControl, isFlagged } from '../clock.ts';
import { type Game, type Player, other, play, timeOut, undo as undoGame } from '../game.ts';
import { nameOf } from '../names.ts';
import {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  type Code,
  type GameRecord,
  type MoveRequest,
  type PlayerInfo,
  type SessionMode,
  type SessionUpdate,
  type SessionView,
  normalizeChat,
  normalizeName,
  toGame,
  toRecord,
} from '../protocol.ts';
import { CURRENT_FORMAT, type SessionDoc } from './format.ts';

export class SessionError extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

// The tokens a caller holds. One device holds its own token; a logged-in player also holds the
// tokens of their other devices; a device that plays the computer also holds the computer's token.
export type Identity = ReadonlySet<string>;

export const COMPUTER_TOKEN = 'computer';

// The generated name of the player on a seat. Null for an empty seat, and for the computer: the page says "Computer".
export const seatName = (token: string | null): string | null => (token === null || token === COMPUTER_TOKEN ? null : nameOf(token));

const emptyRecord = (clock: TimeControl): GameRecord => ({ moves: [], times: [], clock, timedOut: false });

export function currentGame(doc: SessionDoc): Game {
  const record = doc.games.at(-1);
  if (record === undefined) throw new Error('session has no games');
  return toGame(record);
}

// The seats this identity may play. Both, in a friend game on one device.
export function seatsOf(doc: SessionDoc, identity: Identity): Player[] {
  return (['X', 'O'] as const).filter((seat) => {
    const token = doc.seats[seat];
    return token !== null && identity.has(token);
  });
}

function requireSeat(doc: SessionDoc, identity: Identity): Player[] {
  const seats = seatsOf(doc, identity);
  if (seats.length === 0) throw new SessionError(403, 'Only the two players can change this game.');
  return seats;
}

function isLocked(doc: SessionDoc): boolean {
  return doc.lockedGame === doc.games.length - 1 && currentGame(doc).status.kind === 'playing';
}

function replaceCurrent(doc: SessionDoc, game: Game): SessionDoc {
  return { ...doc, games: [...doc.games.slice(0, -1), toRecord(game)] };
}

type NewSession = {
  name: string;
  mode: SessionMode;
  clock?: TimeControl;
  seats: Record<Player, string | null>;
  computer?: { difficulty: Difficulty; seat: Player };
};

export function createDoc({ name, mode, clock = NO_LIMIT, seats, computer }: NewSession): SessionDoc {
  const validName = normalizeName(name);
  if (validName === undefined) throw new SessionError(400, 'A name needs 1 to 40 characters.');
  if ((mode === 'computer') !== (computer !== undefined)) throw new Error('only a computer game has computer settings');
  return {
    format: CURRENT_FORMAT,
    mode,
    computer: computer ?? null,
    name: validName,
    games: [emptyRecord(clock)],
    seats,
    options: { hideBoard: false, hideHistory: false },
    lockedGame: null,
    clock,
    chat: [],
  };
}

// Takes a free seat for `token`. A caller who already holds a seat keeps it.
export function join(doc: SessionDoc, identity: Identity, token: string): SessionDoc {
  if (seatsOf(doc, identity).length > 0) return doc;
  if (doc.seats.X === null) return { ...doc, seats: { ...doc.seats, X: token } };
  if (doc.seats.O === null) return { ...doc, seats: { ...doc.seats, O: token } };
  throw new SessionError(409, 'Both seats are taken. You can watch this game.');
}

export function move(doc: SessionDoc, identity: Identity, request: MoveRequest, now: number): SessionDoc {
  const seats = requireSeat(doc, identity);
  const game = currentGame(doc);
  // The caller sends what it saw. A mismatch means another move landed first.
  if (request.game !== doc.games.length - 1 || request.moveCount !== game.moves.length) {
    throw new SessionError(409, 'The board changed. It now shows the latest moves.');
  }
  if (game.status.kind === 'timeout') throw new SessionError(409, `Time is up. ${other(game.status.winner)} ran out of time.`);
  if (game.status.kind === 'playing' && !seats.includes(game.turn)) throw new SessionError(409, 'It is not your turn.');
  const result = play(game, request.cell, now);
  if (!result.ok) throw new SessionError(409, result.error === 'occupied' ? 'That cell is taken.' : 'This game is over.');
  return replaceCurrent(doc, result.game);
}

// Takes back moves in a game on one device. Online, a move is final.
export function undo(doc: SessionDoc, identity: Identity, count: number): SessionDoc {
  requireSeat(doc, identity);
  if (doc.mode === 'online' || doc.mode === 'nearby') throw new SessionError(409, 'Moves are final in a game with another device.');
  const game = currentGame(doc);
  if (game.status.kind !== 'playing') throw new SessionError(409, 'This game is over.');
  if (game.clock.perMove !== null || game.clock.perGame !== null) throw new SessionError(409, 'A timed game has no undo.');
  if (isLocked(doc)) throw new SessionError(409, 'Settings are locked until this game ends.');
  return replaceCurrent(doc, undoGame(game, count));
}

// An empty session: no game in it has a move. The server and the device prune these after a while.
export const isEmptySession = (doc: SessionDoc): boolean => doc.games.every((game) => game.moves.length === 0);

// How long an empty session stays: a session someone made and never played is gone after this.
export const EMPTY_SESSION_TTL_MS = 9 * 3_600_000;

// A session holds any number of games: the same players can keep playing for as long as they like.
export function newGame(doc: SessionDoc, identity: Identity): SessionDoc {
  requireSeat(doc, identity);
  const game = currentGame(doc);
  // On one device a player may give up a game: it stays in the history, unfinished.
  // With another device involved, a game must end first, so nobody can wipe a game they are losing.
  const sharedGame = doc.mode === 'online' || doc.mode === 'nearby';
  if (sharedGame && game.status.kind === 'playing' && game.moves.length > 0) throw new SessionError(409, 'Finish this game first.');
  // An empty live game is replaced, so a new game never leaves an empty one in the history.
  const games = game.moves.length === 0 ? doc.games.slice(0, -1) : doc.games;
  return { ...doc, games: [...games, emptyRecord(doc.clock)] };
}

// The name stays open during a lock. The match options and the clock do not.
export function update(doc: SessionDoc, identity: Identity, changes: SessionUpdate): SessionDoc {
  requireSeat(doc, identity);
  const changesMatch = changes.hideBoard !== undefined || changes.hideHistory !== undefined || changes.clock !== undefined;
  if (changesMatch && isLocked(doc)) throw new SessionError(409, 'Settings are locked until this game ends.');
  const next: SessionDoc = {
    ...doc,
    name: changes.name ?? doc.name,
    options: {
      hideBoard: changes.hideBoard ?? doc.options.hideBoard,
      hideHistory: changes.hideHistory ?? doc.options.hideHistory,
    },
    clock: changes.clock ?? doc.clock,
  };
  // A game keeps the limit it started with. A game without moves has not started yet.
  const live = next.games.at(-1);
  if (changes.clock !== undefined && live !== undefined && live.moves.length === 0 && !live.timedOut) {
    next.games = [...next.games.slice(0, -1), emptyRecord(changes.clock)];
  }
  return next;
}

// Locks the match options, and every screen's own settings, for both players until the live game ends.
export function lock(doc: SessionDoc, identity: Identity): SessionDoc {
  requireSeat(doc, identity);
  if (isLocked(doc)) return doc;
  if (currentGame(doc).status.kind !== 'playing') throw new SessionError(409, 'This game is over. Start a new game first.');
  return { ...doc, lockedGame: doc.games.length - 1 };
}

// Only the two players write. A message comes from the seat of the caller (X in a friend game).
export function chat(doc: SessionDoc, identity: Identity, text: unknown, now: number): SessionDoc {
  const [seat] = requireSeat(doc, identity);
  if (seat === undefined) throw new Error('requireSeat returned no seat');
  const message = normalizeChat(text);
  if (message === undefined) throw new SessionError(400, `A message needs 1 to ${CHAT_MAX_LENGTH} characters.`);
  const id = (doc.chat.at(-1)?.id ?? 0) + 1;
  return { ...doc, chat: [...doc.chat, { id, from: seat, text: message, at: now }].slice(-CHAT_KEEP) };
}

// Records a timeout that happened since the last change, or returns undefined when there is none.
// The holder of the session calls this on every read, so a flagged clock never depends on a page.
export function settle(doc: SessionDoc, now: number): SessionDoc | undefined {
  const game = currentGame(doc);
  return isFlagged(game, now) ? replaceCurrent(doc, timeOut(game)) : undefined;
}

type ViewContext = {
  code: Code;
  version: number;
  identity: Identity;
  now: number;
  presence: Record<Player, boolean>;
  players: Record<Player, PlayerInfo | null>;
};

export function viewOf(doc: SessionDoc, { code, version, identity, now, presence, players }: ViewContext): SessionView {
  const live = currentGame(doc);
  return {
    code,
    name: doc.name,
    games: doc.games,
    seats: { X: doc.seats.X !== null, O: doc.seats.O !== null },
    you: seatsOf(doc, identity)[0] ?? null,
    options: doc.options,
    locked: isLocked(doc),
    clock: doc.clock,
    now,
    version,
    chat: doc.chat,
    presence,
    players,
    names: { X: seatName(doc.seats.X), O: seatName(doc.seats.O) },
    turn: live.status.kind === 'playing' ? live.turn : null,
    status: live.status,
  };
}

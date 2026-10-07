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
  MATCH_OPTIONS,
  type Code,
  type GameRecord,
  type MoveRequest,
  type PlayerInfo,
  type SeatAction,
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

// The display name of a player without a GitHub login: their custom name, else the generated name.
// The holder of the session knows the custom names; the generated name needs nothing.
export type NameOf = (token: string) => string;

// The name of the player on a seat. Null for an empty seat, and for the computer: the page says "Computer".
export const seatName = (token: string | null, name: NameOf = nameOf): string | null =>
  token === null || token === COMPUTER_TOKEN ? null : name(token);

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
    options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
    lockedGame: null,
    clock,
    chat: [],
    seatRequest: null,
    fixedSeats: false,
    flipped: [false],
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
  // A move ends an undo request: the move to take back is not the last one any more.
  const next = replaceCurrent(doc, result.game);
  return next.seatRequest?.kind === 'undo' ? { ...next, seatRequest: null } : next;
}

// Takes back moves in a game on one device. With another device, an undo is a request (see seat).
export function undo(doc: SessionDoc, identity: Identity, count: number): SessionDoc {
  requireSeat(doc, identity);
  if (doc.mode === 'online' || doc.mode === 'nearby') throw new SessionError(409, 'With another device, the other player must accept an undo.');
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
  if (isLocked(doc)) throw new SessionError(409, 'Settings are locked until this game ends.');
  const game = currentGame(doc);
  // On one device a player may give up a game: it stays in the history, unfinished.
  // With another device involved, a game must end first, so nobody can wipe a game they are losing.
  const sharedGame = doc.mode === 'online' || doc.mode === 'nearby';
  if (sharedGame && game.status.kind === 'playing' && game.moves.length > 0) throw new SessionError(409, 'Finish this game first.');
  // An empty live game is replaced, so a new game never leaves an empty one in the history.
  const played = game.moves.length > 0;
  const games = played ? doc.games : doc.games.slice(0, -1);
  const flipped = played ? doc.flipped : doc.flipped.slice(0, -1);
  // An open seat request stays, and a swap keeps it with its player. An undo request cannot be open
  // here: a move ends it, and a timed game has no undo.
  const next: SessionDoc = { ...doc, games: [...games, emptyRecord(doc.clock)], flipped: [...flipped, false] };
  // After a played game the players swap X and O, so the first move alternates. A friend game
  // holds both seats on one device, so it has nothing to swap.
  return played && !doc.fixedSeats && doc.mode !== 'friend' ? swapSeats(next) : next;
}

// X and O trade players. Each chat message and an open request stay with their player, and each
// game that is over keeps who played it (flipped). A live game goes on with the new seats.
function swapSeats(doc: SessionDoc): SessionDoc {
  const last = doc.games.length - 1;
  const live = currentGame(doc).status.kind === 'playing';
  return {
    ...doc,
    seats: { X: doc.seats.O, O: doc.seats.X },
    computer: doc.computer === null ? null : { ...doc.computer, seat: other(doc.computer.seat) },
    chat: doc.chat.map((message) => ({ ...message, from: other(message.from) })),
    seatRequest: doc.seatRequest === null ? null : { ...doc.seatRequest, from: other(doc.seatRequest.from) },
    flipped: doc.flipped.map((entry, index) => (index === last && live ? entry : !entry)),
  };
}

// The name stays open during a lock. The match options, the clock and the seat rotation do not.
export function update(doc: SessionDoc, identity: Identity, changes: SessionUpdate): SessionDoc {
  requireSeat(doc, identity);
  const changesMatch =
    MATCH_OPTIONS.some((option) => changes[option] !== undefined) || changes.clock !== undefined || changes.fixedSeats !== undefined;
  if (changesMatch && isLocked(doc)) throw new SessionError(409, 'Settings are locked until this game ends.');
  const next: SessionDoc = {
    ...doc,
    name: changes.name ?? doc.name,
    options: {
      hideBoard: changes.hideBoard ?? doc.options.hideBoard,
      hideHistory: changes.hideHistory ?? doc.options.hideHistory,
      hideCoordinates: changes.hideCoordinates ?? doc.options.hideCoordinates,
    },
    clock: changes.clock ?? doc.clock,
    fixedSeats: changes.fixedSeats ?? doc.fixedSeats,
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
  // Without a second player the game cannot end, so the lock would hold for good.
  if (doc.seats.X === null || doc.seats.O === null) throw new SessionError(409, 'Wait for the second player before a lock.');
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

// ---- Seats ----

// Who has the session open, as its holder knows it: the server from its event streams, a Nearby host
// from its connected guests. A watcher has the session open and holds no seat. Its `id` is an opaque
// handle that the holder makes; the token never leaves the holder.
export type OpenWatcher = { id: string; token: string; player: PlayerInfo | null };
export type Audience = { presence: Record<Player, boolean>; watchers: OpenWatcher[]; name: NameOf };

// A request that nobody answers ends after this time.
export const SEAT_REQUEST_MS = 60_000;

type SeatChange = { kind: SeatAction['action']; from: Player; watcher: string | null };

function requireShared(doc: SessionDoc): void {
  if (doc.mode !== 'online' && doc.mode !== 'nearby') throw new SessionError(409, 'Seat changes need a game with another device.');
}

function openRequest(doc: SessionDoc, now: number): SessionDoc['seatRequest'] {
  const request = doc.seatRequest;
  return request !== null && now < request.at + SEAT_REQUEST_MS ? request : null;
}

// The token of a watcher that is here now and holds no seat.
function watcherToken(doc: SessionDoc, watchers: readonly OpenWatcher[], id: string): string {
  const found = watchers.find((watcher) => watcher.id === id);
  if (found === undefined) throw new SessionError(404, 'That watcher is not here any more.');
  if (found.token === doc.seats.X || found.token === doc.seats.O) throw new SessionError(409, 'That watcher has a seat now.');
  return found.token;
}

// Why `from` cannot take back the last move of the live game now, or undefined when it can.
// The rules of undo on one device hold too: a timed game has no undo, and a lock holds the game.
function undoProblem(doc: SessionDoc, from: Player): string | undefined {
  const game = currentGame(doc);
  if (game.status.kind !== 'playing') return 'This game is over.';
  if (game.moves.length === 0 || game.turn === from) return 'Only your own last move can go back, before the other player moves.';
  if (game.clock.perMove !== null || game.clock.perGame !== null) return 'A timed game has no undo.';
  if (isLocked(doc)) return 'Settings are locked until this game ends.';
  return undefined;
}

// Every applied change closes an open request, because the request was about the state before it.
function applySeatChange(doc: SessionDoc, { kind, from, watcher }: SeatChange): SessionDoc {
  if (kind === 'undo') {
    const problem = undoProblem(doc, from);
    if (problem !== undefined) throw new SessionError(409, problem);
    return { ...replaceCurrent(doc, undoGame(currentGame(doc), 1)), seatRequest: null };
  }
  if ((kind === 'give' || kind === 'seat' || kind === 'replace') && watcher === null) throw new Error(`${kind} without a watcher`);
  if (kind === 'swap') return { ...swapSeats(doc), seatRequest: null };
  const to = other(from);
  const seats = { ...doc.seats };
  switch (kind) {
    case 'leave':
      seats[from] = null;
      break;
    case 'give':
      seats[from] = watcher;
      break;
    case 'seat':
    case 'replace':
      seats[to] = watcher;
      break;
    case 'unseat':
      seats[to] = null;
      break;
  }
  return { ...doc, seats, seatRequest: null };
}

// A seated player changes the seats, or takes back the own last move (undo). A change of the other
// player's seat or game (swap, unseat, replace, undo) becomes a request that the other player must accept. A change of the own seat, or of an empty seat,
// applies at once. Watchers cannot change seats; they can only take an empty seat with join.
// A swap is allowed during a game: the players trade sides, and each clock stays with its seat.
export function seat(doc: SessionDoc, identity: Identity, request: SeatAction, watchers: readonly OpenWatcher[], now: number): SessionDoc {
  requireShared(doc);
  const [from] = requireSeat(doc, identity);
  if (from === undefined) throw new Error('requireSeat returned no seat');
  const to = other(from);
  const otherToken = doc.seats[to];
  if (openRequest(doc, now)?.from === to) throw new SessionError(409, 'Answer the request of the other player first.');
  const watcher = 'watcher' in request ? watcherToken(doc, watchers, request.watcher) : null;
  if (request.action === 'seat' && otherToken !== null) throw new SessionError(409, 'The other seat is taken.');
  if ((request.action === 'unseat' || request.action === 'replace') && otherToken === null) {
    throw new SessionError(409, 'The other seat is empty.');
  }
  const problem = request.action === 'undo' ? undoProblem(doc, from) : undefined;
  if (problem !== undefined) throw new SessionError(409, problem);
  const kind = request.action;
  // A player who holds both seats (two devices of one account) asks nobody.
  if ((kind === 'swap' || kind === 'unseat' || kind === 'replace' || kind === 'undo') && otherToken !== null && !identity.has(otherToken)) {
    return { ...doc, seatRequest: { kind, from, watcher, at: now } };
  }
  return applySeatChange(doc, { kind, from, watcher });
}

// The other player accepts or declines an open request. The player who asked can only cancel it
// (accept: false). Accept checks again that the change still applies, and then applies it.
export function answerSeat(doc: SessionDoc, identity: Identity, accept: boolean, watchers: readonly OpenWatcher[], now: number): SessionDoc {
  requireShared(doc);
  const seats = requireSeat(doc, identity);
  const request = openRequest(doc, now);
  if (request === null) throw new SessionError(409, 'There is no open request. It ended or somebody answered it.');
  const target = other(request.from);
  if (!seats.includes(target)) {
    if (accept) throw new SessionError(409, 'Only the other player can accept this request.');
    return { ...doc, seatRequest: null };
  }
  if (!accept) return { ...doc, seatRequest: null };
  if (doc.seats.X === null || doc.seats.O === null) throw new SessionError(409, 'The seats changed. The request no longer applies.');
  if (request.watcher !== null && !watchers.some((watcher) => watcher.token === request.watcher && watcher.token !== doc.seats.X && watcher.token !== doc.seats.O)) {
    throw new SessionError(409, 'That watcher left. Decline the request, or wait until it ends.');
  }
  return applySeatChange(doc, { kind: request.kind, from: request.from, watcher: request.watcher });
}

// Records a timeout that happened since the last change, and drops a seat request that ended.
// Returns undefined when there is nothing to record.
// The holder of the session calls this on every read, so a flagged clock never depends on a page.
export function settle(doc: SessionDoc, now: number): SessionDoc | undefined {
  const game = currentGame(doc);
  let next = isFlagged(game, now) ? replaceCurrent(doc, timeOut(game)) : doc;
  if (doc.seatRequest !== null && openRequest(doc, now) === null) next = { ...next, seatRequest: null };
  return next === doc ? undefined : next;
}

type ViewContext = {
  code: Code;
  version: number;
  identity: Identity;
  now: number;
  audience: Audience;
  players: Record<Player, PlayerInfo | null>;
};

export function viewOf(doc: SessionDoc, { code, version, identity, now, audience, players }: ViewContext): SessionView {
  const live = currentGame(doc);
  const { presence, watchers, name } = audience;
  const request = openRequest(doc, now);
  const requestWatcher = request?.watcher ?? null;
  return {
    code,
    name: doc.name,
    games: doc.games,
    seats: { X: doc.seats.X !== null, O: doc.seats.O !== null },
    you: seatsOf(doc, identity)[0] ?? null,
    options: doc.options,
    locked: isLocked(doc),
    clock: doc.clock,
    fixedSeats: doc.fixedSeats,
    flipped: doc.flipped,
    now,
    version,
    chat: doc.chat,
    presence,
    players,
    names: { X: seatName(doc.seats.X, name), O: seatName(doc.seats.O, name) },
    watchers: watchers.map((watcher) => ({ id: watcher.id, name: name(watcher.token), player: watcher.player })),
    youWatcher: watchers.find((watcher) => identity.has(watcher.token))?.id ?? null,
    seatRequest:
      request === null
        ? null
        : {
            kind: request.kind,
            from: request.from,
            watcher:
              requestWatcher === null
                ? null
                : { name: name(requestWatcher), player: watchers.find((watcher) => watcher.token === requestWatcher)?.player ?? null },
            expiresAt: request.at + SEAT_REQUEST_MS,
          },
    turn: live.status.kind === 'playing' ? live.turn : null,
    status: live.status,
  };
}

// The rules of a session, as pure functions over its document. The server, the page in offline
// play and a Nearby host all run these, so a rule changes in one place for every mode.
// No function here does I/O: each takes a document and returns a new one, or throws a SessionError.
import type { Difficulty } from '../ai.ts';
import { NO_LIMIT, type TimeControl, isFlagged, sameClock } from '../clock.ts';
import { type EpochMs, toEpochMs } from '../epoch.ts';
import { type Game, type Player, other, play, timeOut, undo as undoGame } from '../game.ts';
import { nameOf } from '../names.ts';
import {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  MATCH_OPTIONS,
  type ChatFrom,
  type Code,
  type GameRecord,
  type MoveRequest,
  type PersonId,
  type PlayerInfo,
  type SeatAction,
  type SessionMode,
  type SessionUpdate,
  type SessionEvent,
  type SessionView,
  normalizeChat,
  normalizeName,
  toGame,
  toRecord,
} from '../protocol.ts';
import { PlayoffError, type PlayoffRequest, applyPlayoff } from '../practice/playoff.ts';
import { CURRENT_FORMAT, type SessionDoc, defaultFixedSeats } from './format.ts';

// A code that a client can test, for a refusal that needs a specific reaction.
// already-played: the move is in the game already, so an earlier copy of the request counted.
export const ERROR_CODES = ['already-played'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class SessionError extends Error {
  status: 400 | 403 | 404 | 409;
  code: ErrorCode | undefined;
  constructor(status: 400 | 403 | 404 | 409, message: string, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
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

// A game with another device: online, or Nearby. Only such a game has another person to protect.
const isShared = (doc: SessionDoc): boolean => doc.mode === 'online' || doc.mode === 'nearby';

// A lock holds only in a game with another device. A lock that a one-device game kept from before
// does not hold.
function isLocked(doc: SessionDoc): boolean {
  return isShared(doc) && doc.lockedGame === doc.games.length - 1 && currentGame(doc).status.kind === 'playing';
}

// Adds events to the chat log of a game with another device. A game on one device shows no chat.
// Limit: events count toward CHAT_KEEP, so many changes push old messages out sooner. Revisit this
// if players lose messages that they still want: then keep events in their own short list.
function logEvents(doc: SessionDoc, events: readonly SessionEvent[]): SessionDoc {
  if (!isShared(doc) || events.length === 0) return doc;
  const first = (doc.chat.at(-1)?.id ?? 0) + 1;
  const added = events.map((event, index) => ({ id: first + index, event }));
  return { ...doc, chat: [...doc.chat, ...added].slice(-CHAT_KEEP) };
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
    playoff: null,
    seatRequest: null,
    fixedSeats: defaultFixedSeats(mode),
    watcherChat: true,
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

// True when the game and the move index of the request hold its cell, played by a seat of the caller.
// Then an earlier copy of the request counted, for example one whose answer got lost.
function isPlayed(doc: SessionDoc, seats: readonly Player[], request: MoveRequest): boolean {
  const played = doc.games[request.game]?.moves[request.moveCount];
  const mover: Player = request.moveCount % 2 === 0 ? 'X' : 'O';
  return played === request.cell && seats.includes(mover);
}

export function move(doc: SessionDoc, identity: Identity, request: MoveRequest, now: EpochMs): SessionDoc {
  const seats = requireSeat(doc, identity);
  const game = currentGame(doc);
  // The caller sends what it saw. A mismatch means another move landed first, or this move did.
  if (request.game !== doc.games.length - 1 || request.moveCount !== game.moves.length) {
    if (isPlayed(doc, seats, request)) throw new SessionError(409, 'This move is played already.', 'already-played');
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
  if (isShared(doc)) throw new SessionError(409, 'With another device, the other player must accept an undo.');
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
  if (isShared(doc) && game.status.kind === 'playing' && game.moves.length > 0) throw new SessionError(409, 'Finish this game first.');
  // An empty live game is replaced, so a new game never leaves an empty one in the history.
  const played = game.moves.length > 0;
  const games = played ? doc.games : doc.games.slice(0, -1);
  const flipped = played ? doc.flipped : doc.flipped.slice(0, -1);
  // An open seat request stays, and a swap keeps it with its player. An undo request cannot be open
  // here: a move ends it, and a timed game has no undo.
  const next: SessionDoc = { ...doc, games: [...games, emptyRecord(doc.clock)], flipped: [...flipped, false] };
  // After a played game the players swap X and O, so the first move alternates. A friend game
  // holds both seats on one device, so it has nothing to swap.
  if (!played) return next;
  const swapped = !doc.fixedSeats && doc.mode !== 'friend';
  return logEvents(swapped ? swapSeats(next) : next, [{ kind: 'new-game', game: next.games.length, swapped }]);
}

// X and O trade players. An open request stays with its player, and each
// game that is over keeps who played it (flipped). A live game goes on with the new seats.
function swapSeats(doc: SessionDoc): SessionDoc {
  const last = doc.games.length - 1;
  const live = currentGame(doc).status.kind === 'playing';
  return {
    ...doc,
    seats: { X: doc.seats.O, O: doc.seats.X },
    computer: doc.computer === null ? null : { ...doc.computer, seat: other(doc.computer.seat) },
    seatRequest: doc.seatRequest === null ? null : { ...doc.seatRequest, from: other(doc.seatRequest.from) },
    // The same two players hold the seats, so a sound playoff goes on, with each player's progress.
    playoff: doc.playoff === null ? null : { ...doc.playoff, by: other(doc.playoff.by), seats: { X: doc.playoff.seats.O, O: doc.playoff.seats.X } },
    flipped: doc.flipped.map((entry, index) => (index === last && live ? entry : !entry)),
  };
}

// The name and the watcher chat stay open during a lock. The match options, the clock and the seat rotation do not.
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
    watcherChat: changes.watcherChat ?? doc.watcherChat,
  };
  // A game keeps the limit it started with. A game without moves has not started yet.
  const live = next.games.at(-1);
  if (changes.clock !== undefined && live !== undefined && live.moves.length === 0 && !live.timedOut) {
    next.games = [...next.games.slice(0, -1), emptyRecord(changes.clock)];
  }
  const events: SessionEvent[] = [];
  if (next.name !== doc.name) events.push({ kind: 'name', name: next.name });
  for (const option of MATCH_OPTIONS) {
    if (next.options[option] !== doc.options[option]) events.push({ kind: 'option', option, on: next.options[option] });
  }
  if (!sameClock(next.clock, doc.clock)) events.push({ kind: 'clock', clock: next.clock });
  if (next.fixedSeats !== doc.fixedSeats) events.push({ kind: 'fixed-seats', on: next.fixedSeats });
  if (next.watcherChat !== doc.watcherChat) events.push({ kind: 'watcher-chat', on: next.watcherChat });
  return logEvents(next, events);
}

// Locks the rules of the live game for both players until it ends: the match options, the clock,
// the seat rotation and undo. It is a promise between two people, so a one-device game has no lock.
export function lock(doc: SessionDoc, identity: Identity): SessionDoc {
  requireSeat(doc, identity);
  if (!isShared(doc)) throw new SessionError(409, 'A lock needs a game with another device.');
  if (isLocked(doc)) return doc;
  if (currentGame(doc).status.kind !== 'playing') throw new SessionError(409, 'This game is over. Start a new game first.');
  // Without a second player the game cannot end, so the lock would hold for good.
  if (doc.seats.X === null || doc.seats.O === null) throw new SessionError(409, 'Wait for the second player before a lock.');
  return logEvents({ ...doc, lockedGame: doc.games.length - 1 }, [{ kind: 'lock' }]);
}

// The two players write, and the watchers too while watcherChat is on. A message comes from the seat
// of the caller (X in a friend game), else from 'watcher'. `author` is the person id of the caller, from
// the holder of the session. Null when the holder has none (a game on one device): then the message has no `by`.
export function chat(
  doc: SessionDoc,
  identity: Identity,
  text: unknown,
  now: EpochMs,
  author: PersonId | null,
  watchers: readonly OpenWatcher[],
): SessionDoc {
  const from = chatSeat(doc, identity, watchers);
  const message = normalizeChat(text);
  if (message === undefined) throw new SessionError(400, `A message needs 1 to ${CHAT_MAX_LENGTH} characters.`);
  const id = (doc.chat.at(-1)?.id ?? 0) + 1;
  const sent = { id, from, text: message, at: now, ...(author === null ? {} : { by: author }) };
  return { ...doc, chat: [...doc.chat, sent].slice(-CHAT_KEEP) };
}

function chatSeat(doc: SessionDoc, identity: Identity, watchers: readonly OpenWatcher[]): ChatFrom {
  const [seat] = seatsOf(doc, identity);
  if (seat !== undefined) return seat;
  if (!watchers.some((watcher) => identity.has(watcher.token))) throw new SessionError(403, 'Open the game to chat.');
  if (!doc.watcherChat) throw new SessionError(403, 'The players turned off chat for watchers.');
  return 'watcher';
}

// A request of a player for the sound playoff of an online session (src/practice/playoff.ts).
export function playoff(doc: SessionDoc, identity: Identity, request: PlayoffRequest, now: number): SessionDoc {
  if (doc.mode !== 'online') throw new SessionError(409, 'A playoff needs an online game.');
  const [seat] = requireSeat(doc, identity);
  if (seat === undefined) throw new Error('requireSeat returned no seat');
  try {
    const next = applyPlayoff(doc.playoff, seat, doc.seats.X !== null && doc.seats.O !== null, request, now);
    return next === doc.playoff ? doc : { ...doc, playoff: next };
  } catch (error) {
    if (error instanceof PlayoffError) throw new SessionError(error.status === 409 ? 409 : 400, error.message);
    throw error;
  }
}

// ---- Seats ----

// Who has the session open, as its holder knows it: the server from its event streams, a Nearby host
// from its connected guests. A watcher has the session open and holds no seat. Its `id` is an opaque
// handle that the holder makes; the token never leaves the holder.
export type OpenWatcher = { id: string; token: string; player: PlayerInfo | null };
// `person` gives the public person id of a token (personId in src/protocol.ts), or null when the holder has none yet.
export type Audience = { presence: Record<Player, boolean>; watchers: OpenWatcher[]; name: NameOf; person: (token: string) => PersonId | null };

// A request that nobody answers ends after this time.
export const SEAT_REQUEST_MS = 60_000;

type SeatChange = { kind: SeatAction['action']; from: Player; watcher: string | null };

function requireShared(doc: SessionDoc): void {
  if (!isShared(doc)) throw new SessionError(409, 'Seat changes need a game with another device.');
}

function openRequest(doc: SessionDoc, now: EpochMs): SessionDoc['seatRequest'] {
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
// A change of who holds a seat also ends a sound playoff: the playoff is stored by seat, so a new holder of a
// seat must not take over the progress of the player before. Both pages see the playoff go to null.
// A swap keeps the same two players, so the playoff goes on with them (swapSeats).
// Limit: the next playoff starts again at id 1, so a late request for the ended playoff can reach it.
// That needs a request in flight across a seat change, and a playoff is friendly. Revisit this if a
// stale hit ever shows in a new playoff: then keep a playoff counter in the session document.
function applySeatChange(doc: SessionDoc, change: SeatChange): SessionDoc {
  return logEvents(seatChanged(doc, change), [{ kind: 'seat', action: change.kind }]);
}

function seatChanged(doc: SessionDoc, { kind, from, watcher }: SeatChange): SessionDoc {
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
  return { ...doc, seats, seatRequest: null, playoff: null };
}

// A seated player changes the seats, or takes back the own last move (undo). A change of the other
// player's seat or game (swap, unseat, replace, undo) becomes a request that the other player must accept. A change of the own seat, or of an empty seat,
// applies at once. Watchers cannot change seats; they can only take an empty seat with join.
// A swap is allowed during a game: the players trade sides, and each clock stays with its seat.
export function seat(doc: SessionDoc, identity: Identity, request: SeatAction, watchers: readonly OpenWatcher[], now: EpochMs): SessionDoc {
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
export function answerSeat(doc: SessionDoc, identity: Identity, accept: boolean, watchers: readonly OpenWatcher[], now: EpochMs): SessionDoc {
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
export function settle(doc: SessionDoc, now: EpochMs): SessionDoc | undefined {
  const game = currentGame(doc);
  let next = isFlagged(game, now) ? replaceCurrent(doc, timeOut(game)) : doc;
  if (doc.seatRequest !== null && openRequest(doc, now) === null) next = { ...next, seatRequest: null };
  return next === doc ? undefined : next;
}

type ViewContext = {
  code: Code;
  version: number;
  identity: Identity;
  now: EpochMs;
  audience: Audience;
  players: Record<Player, PlayerInfo | null>;
};

export function viewOf(doc: SessionDoc, { code, version, identity, now, audience, players }: ViewContext): SessionView {
  const live = currentGame(doc);
  const { presence, watchers, name, person } = audience;
  const seatPerson = (token: string | null) => (token === null || token === COMPUTER_TOKEN ? null : person(token));
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
    watcherChat: doc.watcherChat,
    flipped: doc.flipped,
    now,
    version,
    chat: doc.chat,
    presence,
    players,
    names: { X: seatName(doc.seats.X, name), O: seatName(doc.seats.O, name) },
    people: { X: seatPerson(doc.seats.X), O: seatPerson(doc.seats.O) },
    watchers: watchers.map((watcher) => ({ id: watcher.id, name: name(watcher.token), player: watcher.player, person: person(watcher.token) })),
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
            expiresAt: toEpochMs(request.at + SEAT_REQUEST_MS),
          },
    turn: live.status.kind === 'playing' ? live.turn : null,
    status: live.status,
    playoff: doc.playoff,
  };
}

// Contract between the page and the online API. Both sides import this file.
import { DIFFICULTIES, type Difficulty } from './ai.ts';
import { NO_LIMIT, type TimeControl, parseClock } from './clock.ts';
import { type EpochMs, isEpochMs } from './epoch.ts';
import { CELL_COUNT, type Game, type Player, type Status, other, replay, timeOut } from './game.ts';
import type { DeviceKind } from './nearby/device.ts';
import { type Tuning, isTuning, parseTuning } from './tuning.ts';
import { type Playoff, parsePlayoff } from './practice/playoff.ts';
import type { PracticeStats } from './practice/practice.ts';
import { isRecord, isUnknownArray } from './guards.ts';

// Letters and digits without the look-alikes 0/O and 1/I, so a code read aloud is not ambiguous.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
// Stored session documents pass the same checks when they are read (see src/session/format.ts).
// So NAME_MAX_LENGTH and CHAT_MAX_LENGTH may only grow. To make one smaller, first make parseDoc
// cut longer stored values, or old sessions stop loading.
export const NAME_MAX_LENGTH = 40;
// Sessions and games per session have no limit. Add one when storage use calls for it.
export const CHAT_MAX_LENGTH = 200;
// A session keeps its newest messages only.
export const CHAT_KEEP = 50;

export type Code = string & { readonly __brand: 'Code' };
export type PlayerToken = string & { readonly __brand: 'PlayerToken' };

// Match options apply to both players and to watchers. View and layout stay per screen.
// hideCoordinates hides the coordinates of the last move on the keypad, so a player follows the game by ear.
export type MatchOptions = { hideBoard: boolean; hideHistory: boolean; hideCoordinates: boolean };
export const MATCH_OPTIONS = ['hideBoard', 'hideHistory', 'hideCoordinates'] as const;

// Reads match options. A sender or a stored value from before hideCoordinates has no such field: it reads as false.
export function parseMatchOptions(value: unknown): MatchOptions | undefined {
  if (!isRecord(value) || typeof value.hideBoard !== 'boolean' || typeof value.hideHistory !== 'boolean') return undefined;
  const hideCoordinates = value.hideCoordinates ?? false;
  if (typeof hideCoordinates !== 'boolean') return undefined;
  return { hideBoard: value.hideBoard, hideHistory: value.hideHistory, hideCoordinates };
}

// `from` is the seat of the sender when they sent the message. `by` is the person id of the sender
// (personId). A message from before person ids has no `by`: the page then shows the holder of `from`.
export type ChatMessage = { id: number; from: Player; text: string; at: EpochMs; by?: PersonId };
// A GitHub account linked to a seat. Shown next to the seat, never required to play.
export type PlayerInfo = { login: string; avatar: string };
// The generated name of each seat's player (src/names.ts). The server computes it from the seat's
// token, so the token never leaves the server. Null for an empty seat, the computer, or an unknown player.
type SeatNames = Record<Player, string | null>;
export const SESSION_MODES = ['online', 'computer', 'friend', 'nearby'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
// One game as stored: moves, the time of each move, its time limit, and whether the player to move ran out of time.
export type GameRecord = { moves: number[]; times: EpochMs[]; clock: TimeControl; timedOut: boolean };

// The seat in game `index` of the player on `seat` now, and the reverse: a swap is its own inverse.
// `flipped` has one entry per game: true when the two players sat the other way round in that game.
export const seatIn = (flipped: readonly boolean[], index: number, seat: Player): Player => (flipped[index] === true ? other(seat) : seat);

export type SessionView = {
  code: Code;
  name: string;
  games: GameRecord[];
  seats: Record<Player, boolean>;
  you: Player | null;
  options: MatchOptions;
  // True while a lock holds: from the lock until the live game ends.
  locked: boolean;
  // The time limit for the next game. Each game keeps the limit it started with.
  clock: TimeControl;
  // False: the players swap X and O for each new game, so X (who moves first) alternates.
  // True: the seats stay the same from game to game.
  fixedSeats: boolean;
  // One entry per game: true when the two players sat the other way round in that game (see seatIn).
  flipped: boolean[];
  // Server time when the view was made. Pages use it to correct their own clock.
  now: EpochMs;
  version: number;
  // Oldest first. Only the two players can write, everybody with the code can read.
  chat: ChatMessage[];
  // Which seats have the session open right now. A seat that is away still plays: moves wait for it.
  presence: Record<Player, boolean>;
  // The GitHub account behind each seat, when its player logged in.
  players: Record<Player, PlayerInfo | null>;
  // The generated name of each seat's player (src/names.ts). Null for an empty seat and for the computer.
  names: SeatNames;
  // The public person id of each seat's player (personId). Null for an empty seat, the computer, or a holder that sends none.
  people: Record<Player, PersonId | null>;
  // The devices that have the session open without a seat, as the holder of the session knows them.
  watchers: Watcher[];
  // The watcher id of the caller, when the caller watches. Null for a player and for a caller that the holder does not see.
  youWatcher: string | null;
  // A seat change that waits for the other player to accept, or null.
  seatRequest: SeatRequestView | null;
  // The live game (the last one in `games`), so an API client needs no rules of its own.
  // `turn` is the player to move, or null when the game is over.
  turn: Player | null;
  status: Status;
  // The sound playoff of the session, or null (src/practice/playoff.ts).
  playoff: Playoff | null;
};

// ---- Seats ----

// What a seated player can do with the seats in a game with another device (src/session/core.ts).
// swap: X and O trade seats. leave: I watch, my seat empties. give: my seat goes to a watcher.
// seat: a watcher takes the empty seat. unseat: the other player watches. replace: a watcher takes the other seat.
// undo: takes back my last move, while the other player has not moved since.
export const SEAT_ACTIONS = ['swap', 'leave', 'give', 'seat', 'unseat', 'replace', 'undo'] as const;
// The actions that change the seat or the game of the other player. They wait until the other player accepts.
export const CONSENT_ACTIONS = ['swap', 'unseat', 'replace', 'undo'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export type SeatAction = { action: 'swap' | 'leave' | 'unseat' | 'undo' } | { action: 'give' | 'seat' | 'replace'; watcher: string };
export type SeatAnswer = { accept: boolean };
// A watcher id is an opaque handle that the holder of the session makes. It is never a player token.
export const WATCHER_ID_LENGTH = 16;
const WATCHER_ID_CHARS = '0123456789abcdef';
// `person` is the public person id of the watcher (personId), or null from a holder that sends none.
type Watcher = { id: string; name: string; player: PlayerInfo | null; person: PersonId | null };
export type SeatRequestView = {
  kind: ConsentAction;
  from: Player;
  // The watcher that takes the other seat, for replace. Null for the other actions.
  watcher: { name: string; player: PlayerInfo | null } | null;
  // The request ends at this time (server time) when nobody answers.
  expiresAt: EpochMs;
};

const isWatcherId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === WATCHER_ID_LENGTH && [...value].every((char) => WATCHER_ID_CHARS.includes(char));

// The body of POST /api/sessions/{code}/seats. Refuses an unknown action, a missing or extra watcher, and extra fields.
export function parseSeatAction(value: unknown): SeatAction | undefined {
  if (!isRecord(value)) return undefined;
  const action = oneOf(SEAT_ACTIONS, value.action);
  if (action === undefined) return undefined;
  if (action === 'give' || action === 'seat' || action === 'replace') {
    return hasOnlyKeys(value, ['action', 'watcher']) && isWatcherId(value.watcher) ? { action, watcher: value.watcher } : undefined;
  }
  return hasOnlyKeys(value, ['action']) ? { action } : undefined;
}

// The body of POST /api/sessions/{code}/seats/answer.
export function parseSeatAnswer(value: unknown): SeatAnswer | undefined {
  return isRecord(value) && hasOnlyKeys(value, ['accept']) && typeof value.accept === 'boolean' ? { accept: value.accept } : undefined;
}

function parseWatcher(value: unknown): Watcher | undefined {
  if (!isRecord(value) || !isWatcherId(value.id) || !isDisplayName(value.name)) return undefined;
  const player = value.player === null ? null : parsePlayerInfo(value.player);
  // An older server or Nearby host sends no person id.
  const person = value.person === undefined || value.person === null ? null : parsePersonId(value.person);
  return player === undefined || person === undefined ? undefined : { id: value.id, name: value.name, player, person };
}

function parseSeatRequestView(value: unknown): SeatRequestView | undefined {
  if (!isRecord(value)) return undefined;
  const kind = oneOf(CONSENT_ACTIONS, value.kind);
  const { from, expiresAt } = value;
  if (kind === undefined || (from !== 'X' && from !== 'O') || !isEpochMs(expiresAt)) return undefined;
  let watcher: SeatRequestView['watcher'] = null;
  if (value.watcher !== null) {
    if (!isRecord(value.watcher) || !isDisplayName(value.watcher.name)) return undefined;
    const player = value.watcher.player === null ? null : parsePlayerInfo(value.watcher.player);
    if (player === undefined) return undefined;
    watcher = { name: value.watcher.name, player };
  }
  if ((kind === 'replace') !== (watcher !== null)) return undefined;
  return { kind, from, watcher, expiresAt };
}

// ---- People: report and block ----

// The public id of a person: the first PERSON_ID_LENGTH hex characters of SHA-256 over a prefix and
// the token. A token is a random UUID, so the id does not reveal it. An account token
// ("account-<GitHub id>") reveals only the GitHub id, which is public. The hash has no key, so the
// server and a Nearby host give one device the same id, and DuckDB's sha256() finds the same id.
export type PersonId = string & { readonly __brand: 'PersonId' };
export const PERSON_ID_LENGTH = 16;
export const PERSON_ID_PREFIX = 'tick3d-person:';
const HEX_CHARS = '0123456789abcdef';

export async function personId(token: string): Promise<PersonId> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PERSON_ID_PREFIX}${token}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, PERSON_ID_LENGTH) as PersonId;
}

export function parsePersonId(value: unknown): PersonId | undefined {
  return typeof value === 'string' && value.length === PERSON_ID_LENGTH && [...value].every((char) => HEX_CHARS.includes(char))
    ? (value as PersonId)
    : undefined;
}

// A person that the caller blocked. `name` is the name that the caller saw at the block, for the unblock list.
export type BlockedPerson = { person: PersonId; name: string; at: EpochMs };

// The answer of GET /api/me/blocks, newest first.
export function parseBlocks(value: unknown): BlockedPerson[] {
  const blocked = isRecord(value) ? value.blocked : undefined;
  if (!isUnknownArray(blocked)) throw new Error('invalid answer from /api/me/blocks');
  return blocked.map((entry) => {
    const person = isRecord(entry) ? parsePersonId(entry.person) : undefined;
    if (!isRecord(entry) || person === undefined || !isDisplayName(entry.name) || !isEpochMs(entry.at)) throw new Error('invalid blocked person');
    return { person, name: entry.name, at: entry.at };
  });
}

// The body of PUT /api/me/blocks/{person}.
export function parseBlockRequest(value: unknown): { name: string } | undefined {
  return isRecord(value) && hasOnlyKeys(value, ['name']) && isDisplayName(value.name) ? { name: value.name } : undefined;
}

export const REPORT_REASONS = ['spam', 'abuse', 'name', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_NOTE_MAX_LENGTH = 200;
// A report names one chat message of an online session, or one person in it.
type ReportTarget = { message: number } | { person: PersonId };
export type ReportRequest = { code: Code; target: ReportTarget; reason: ReportReason; note: string | null };

const isMessageId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

// The body of POST /api/reports: { code, message | person, reason, note? }. Exactly one target.
export function parseReportRequest(value: unknown): ReportRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message', 'person', 'reason', 'note'])) return undefined;
  const code = typeof value.code === 'string' ? normalizeCode(value.code) : undefined;
  const reason = oneOf(REPORT_REASONS, value.reason);
  const note = value.note === undefined || value.note === null ? '' : typeof value.note === 'string' ? value.note.trim() : undefined;
  if (code === undefined || reason === undefined || note === undefined || note.length > REPORT_NOTE_MAX_LENGTH) return undefined;
  if ((value.message === undefined) === (value.person === undefined)) return undefined;
  const base = { code, reason, note: note === '' ? null : note };
  if (value.message !== undefined) return isMessageId(value.message) ? { ...base, target: { message: value.message } } : undefined;
  const person = parsePersonId(value.person);
  return person === undefined ? undefined : { ...base, target: { person } };
}

// ---- Custom names ----

// A player without a GitHub login can replace the generated name with a name of their own.
// The same limit as a Nearby device name (HELLO_NAME_MAX_LENGTH), so a custom name fits there.
export const CUSTOM_NAME_MIN_LENGTH = 2;
export const CUSTOM_NAME_MAX_LENGTH = 24;

// Trims, collapses inner spaces, and allows letters of any script, digits, spaces, "-" and "_".
// The server also refuses a name that equals a GitHub login, so nobody can pose as a logged-in player.
export function parseCustomName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // A regex is the simplest way to match the letters and digits of every script (Unicode properties).
  const name = value.trim().split(/\s+/u).join(' ');
  const length = [...name].length;
  if (length < CUSTOM_NAME_MIN_LENGTH || length > CUSTOM_NAME_MAX_LENGTH) return undefined;
  return /^[\p{L}\p{M}\p{Nd} _-]+$/u.test(name) && /[\p{L}\p{Nd}]/u.test(name) ? name : undefined;
}

export type SessionUpdate = { name?: string; clock?: TimeControl; fixedSeats?: boolean } & Partial<MatchOptions>;

export function toGame(record: GameRecord): Game {
  const game = replay(record.moves, { times: record.times, clock: record.clock });
  return record.timedOut ? timeOut(game) : game;
}

export function toRecord(game: Game): GameRecord {
  return { moves: [...game.moves], times: [...game.times], clock: game.clock, timedOut: game.status.kind === 'timeout' };
}

export type MoveRequest = { game: number; moveCount: number; cell: number };

// The body of POST /api/sessions. The clock is optional and defaults to no limit.
export type NewSession = { name: string; clock: TimeControl };

export function parseNewSession(value: unknown): NewSession | undefined {
  if (!isRecord(value)) return undefined;
  const name = normalizeName(value.name);
  const clock = value.clock === undefined ? NO_LIMIT : parseClock(value.clock);
  return name === undefined || clock === undefined ? undefined : { name, clock };
}

export function normalizeCode(input: string): Code | undefined {
  const code = input.trim().toUpperCase();
  const valid = code.length === CODE_LENGTH && [...code].every((char) => CODE_ALPHABET.includes(char));
  return valid ? (code as Code) : undefined;
}

export function normalizeName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const name = input.trim();
  return name.length >= 1 && name.length <= NAME_MAX_LENGTH ? name : undefined;
}

export function normalizeChat(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  return text.length >= 1 && text.length <= CHAT_MAX_LENGTH ? text : undefined;
}

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';

// The server keeps a seat that a logged-in player takes under the account, with this prefix and the
// GitHub id (server/store.ts). A GitHub id is public, so no client may send such a token as its own.
export const ACCOUNT_TOKEN_PREFIX = 'account-';

// A token is a crypto.randomUUID() kept in the browser. It proves which seat a browser holds.
export function asPlayerToken(input: unknown): PlayerToken | undefined {
  if (typeof input !== 'string' || input.length < 16 || input.length > 64 || input.startsWith(ACCOUNT_TOKEN_PREFIX)) return undefined;
  return [...input].every((char) => TOKEN_CHARS.includes(char)) ? (input as PlayerToken) : undefined;
}

const isCell = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CELL_COUNT;

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  const { id, from, text, at, by } = value;
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    (from === 'X' || from === 'O') &&
    normalizeChat(text) === text &&
    isEpochMs(at) &&
    (by === undefined || parsePersonId(by) !== undefined)
  );
}

export function isMoveList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= CELL_COUNT && value.every(isCell);
}

export function isGameRecord(value: unknown): value is GameRecord {
  if (!isRecord(value)) return false;
  const { moves, times, timedOut, clock } = value;
  return (
    isMoveList(moves) &&
    Array.isArray(times) &&
    times.length === moves.length &&
    times.every(isEpochMs) &&
    typeof timedOut === 'boolean' &&
    parseClock(clock) !== undefined
  );
}

export function parseMoveRequest(value: unknown): MoveRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { game, moveCount, cell } = value;
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return isCount(game) && isCount(moveCount) && isCell(cell) ? { game, moveCount, cell } : undefined;
}

// Returns undefined for an unknown field, a wrong type, an invalid name, or an empty update.
export function parseSessionUpdate(value: unknown): SessionUpdate | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  const known = ['name', ...MATCH_OPTIONS, 'clock', 'fixedSeats'];
  if (keys.length === 0 || !keys.every((key) => known.includes(key))) return undefined;
  const update: SessionUpdate = {};
  if ('name' in value) {
    const name = normalizeName(value.name);
    if (name === undefined) return undefined;
    update.name = name;
  }
  if ('clock' in value) {
    const clock = parseClock(value.clock);
    if (clock === undefined) return undefined;
    update.clock = clock;
  }
  if ('fixedSeats' in value) {
    if (typeof value.fixedSeats !== 'boolean') return undefined;
    update.fixedSeats = value.fixedSeats;
  }
  for (const option of MATCH_OPTIONS) {
    if (!(option in value)) continue;
    const flag = value[option];
    if (typeof flag !== 'boolean') return undefined;
    update[option] = flag;
  }
  return update;
}

// Throws on any unexpected shape, so a server change can never half-render on the page.
export function parseSessionView(value: unknown): SessionView {
  const fail = (field: string): never => {
    throw new Error(`invalid session from server: ${field}`);
  };
  if (!isRecord(value)) return fail('body');
  const code = typeof value.code === 'string' ? normalizeCode(value.code) : undefined;
  const name = normalizeName(value.name);
  const { games, seats, you, options, locked, now, version, chat, presence, players } = value;
  // An older server, an older Nearby host or a cached view sends no names, watchers or seat request.
  const names = value.names === undefined ? { X: null, O: null } : parseSeatNames(value.names);
  // An older server, an older Nearby host or a cached view sends no person ids.
  const people = value.people === undefined ? { X: null, O: null } : parsePeople(value.people);
  const watchers = value.watchers === undefined ? [] : Array.isArray(value.watchers) ? value.watchers.map(parseWatcher) : undefined;
  const youWatcher = value.youWatcher === undefined || value.youWatcher === null ? null : isWatcherId(value.youWatcher) ? value.youWatcher : undefined;
  const seatRequest = value.seatRequest === undefined || value.seatRequest === null ? null : parseSeatRequestView(value.seatRequest);
  // An older server, an older Nearby host or a cached view sends no seat rotation: the seats stayed fixed then.
  const fixedSeats = value.fixedSeats ?? true;
  const flipped = value.flipped ?? (Array.isArray(games) ? games.map(() => false) : undefined);
  const clock = parseClock(value.clock);
  if (code === undefined) return fail('code');
  if (name === undefined) return fail('name');
  if (!Array.isArray(games) || games.length === 0 || !games.every(isGameRecord)) return fail('games');
  if (!isRecord(seats) || typeof seats.X !== 'boolean' || typeof seats.O !== 'boolean') return fail('seats');
  if (you !== null && you !== 'X' && you !== 'O') return fail('you');
  const matchOptions = parseMatchOptions(options);
  if (matchOptions === undefined) return fail('options');
  if (typeof locked !== 'boolean') return fail('locked');
  if (clock === undefined) return fail('clock');
  if (!isEpochMs(now)) return fail('now');
  if (typeof version !== 'number' || !Number.isInteger(version)) return fail('version');
  if (!Array.isArray(chat) || chat.length > CHAT_KEEP || !chat.every(isChatMessage)) return fail('chat');
  if (!isRecord(presence) || typeof presence.X !== 'boolean' || typeof presence.O !== 'boolean') return fail('presence');
  if (!isRecord(players)) return fail('players');
  const playerX = players.X === null ? null : parsePlayerInfo(players.X);
  const playerO = players.O === null ? null : parsePlayerInfo(players.O);
  if (playerX === undefined || playerO === undefined) return fail('players');
  if (names === undefined) return fail('names');
  if (people === undefined) return fail('people');
  // An older server, a Nearby host or a cached view sends no playoff.
  const playoff = value.playoff === undefined || value.playoff === null ? null : parsePlayoff(value.playoff);
  if (playoff === undefined) return fail('playoff');
  if (watchers === undefined || !watchers.every((watcher) => watcher !== undefined)) return fail('watchers');
  if (seatRequest === undefined) return fail('seatRequest');
  if (youWatcher === undefined) return fail('youWatcher');
  if (typeof fixedSeats !== 'boolean') return fail('fixedSeats');
  if (!Array.isArray(flipped) || flipped.length !== games.length || !flipped.every((entry): entry is boolean => typeof entry === 'boolean')) return fail('flipped');
  // The rules give the live status. A sender without these fields (an older server, a Nearby host
  // or a cached view) is fine. A sender with fields that disagree with the moves is not.
  const last: unknown = games.at(-1);
  if (!isGameRecord(last)) return fail('games');
  let live: Game;
  try {
    live = toGame(last);
  } catch {
    return fail('games');
  }
  const turn = live.status.kind === 'playing' ? live.turn : null;
  if ('turn' in value && value.turn !== turn) return fail('turn');
  if ('status' in value && !sameStatus(value.status, live.status)) return fail('status');
  return {
    code,
    name,
    games,
    seats: { X: seats.X, O: seats.O },
    you,
    options: matchOptions,
    locked,
    clock,
    fixedSeats,
    flipped,
    now,
    version,
    chat: chat.map(({ id, from, text, at, by }) => ({ id, from, text, at, ...(by === undefined ? {} : { by }) })),
    presence: { X: presence.X, O: presence.O },
    players: { X: playerX, O: playerO },
    names,
    people,
    watchers,
    youWatcher,
    seatRequest,
    turn,
    status: live.status,
    playoff,
  };
}

function sameStatus(value: unknown, status: Status): boolean {
  if (!isRecord(value) || value.kind !== status.kind) return false;
  const winner = status.kind === 'won' || status.kind === 'timeout' ? status.winner : undefined;
  const line = status.kind === 'won' ? status.line : undefined;
  const sameLine = Array.isArray(value.line) && line !== undefined && value.line.join() === line.join();
  return value.winner === winner && (line === undefined ? !('line' in value) : sameLine);
}

const GITHUB_LOGIN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

const isDisplayName = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= NAME_MAX_LENGTH;
const isSeatName = (value: unknown): value is string | null => value === null || isDisplayName(value);

function parsePeople(value: unknown): Record<Player, PersonId | null> | undefined {
  if (!isRecord(value)) return undefined;
  const x = value.X === null ? null : parsePersonId(value.X);
  const o = value.O === null ? null : parsePersonId(value.O);
  return x === undefined || o === undefined ? undefined : { X: x, O: o };
}

function parseSeatNames(value: unknown): SeatNames | undefined {
  return isRecord(value) && isSeatName(value.X) && isSeatName(value.O) ? { X: value.X, O: value.O } : undefined;
}

export function parsePlayerInfo(value: unknown): PlayerInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { login, avatar } = value;
  if (typeof login !== 'string' || login.length < 1 || login.length > 39) return undefined;
  if (![...login].every((char) => GITHUB_LOGIN_CHARS.includes(char))) return undefined;
  // Avatars come from GitHub only, so a page never loads an image from an address a player chose.
  if (typeof avatar !== 'string' || !avatar.startsWith('https://avatars.githubusercontent.com/')) return undefined;
  return { login, avatar };
}

// ---- Game links ----

// The public id of one finished game, for its read-only link (`/?game=<id>`).
// An online game: "<CODE>-<n>", where n is its 1-based number in the session.
// Any other game: DEVICE_GAME_ID_LENGTH random characters that the device makes at the end of the game.
// The id of a stored result holds a player token, so only this id may leave the server.
// The check functions below mint both kinds, so a GameId always has one of the two forms.
export type DeviceGameId = string & { readonly __brand: 'DeviceGameId' };
export type OnlineGameId = `${string}-${number}` & { readonly __brand: 'OnlineGameId' };
export type GameId = DeviceGameId | OnlineGameId;
export const DEVICE_GAME_ID_LENGTH = 8;
// Game numbers above this are not real: a session of a million games has never happened.
const MAX_GAME_NUMBER = 1_000_000;

export function newGameId(): DeviceGameId {
  // 256 is a multiple of the 32 characters, so every character is equally likely.
  const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_GAME_ID_LENGTH));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('') as DeviceGameId;
}

export const onlineGameId = (code: Code, index: number): OnlineGameId => `${code}-${index + 1}` as OnlineGameId;

// A device id has no dash; an online id always has one.
export const isOnlineGameId = (id: GameId): id is OnlineGameId => id.includes('-');

// The session code and the 0-based game index of an online id.
export function onlineGameParts(id: OnlineGameId): { code: Code; index: number } {
  const [code, number] = id.split('-');
  const parsed = normalizeCode(code ?? '');
  if (parsed === undefined || parsed !== code) throw new Error(`not an online game id: ${id}`);
  return { code: parsed, index: Number(number) - 1 };
}

// Only the exact form that newGameId makes: no trimming, no case change.
export function parseDeviceGameId(input: unknown): DeviceGameId | undefined {
  const id = parseGameId(input);
  return id !== undefined && id === input && !isOnlineGameId(id) ? id : undefined;
}

// Accepts either form in any case, and returns it in upper case.
export function parseGameId(input: unknown): GameId | undefined {
  if (typeof input !== 'string') return undefined;
  const id = input.trim().toUpperCase();
  if (id.length === DEVICE_GAME_ID_LENGTH && [...id].every((char) => CODE_ALPHABET.includes(char))) return id as DeviceGameId;
  const [code, number, ...rest] = id.split('-');
  if (code === undefined || number === undefined || rest.length > 0 || normalizeCode(code) !== code) return undefined;
  const n = Number(number);
  // String(n) === number refuses leading zeros, signs and exponents.
  return Number.isInteger(n) && n >= 1 && n <= MAX_GAME_NUMBER && String(n) === number ? (id as OnlineGameId) : undefined;
}

// ---- Game metrics ----

// The page settings that a result reports. The page reads its choices from these lists too.
export const VIEWS = ['tower', 'flat'] as const;
export const LAYOUTS = ['grid', 'row', 'column', 'steps'] as const;
// Palettes in style.css, in menu order. index.html and stats.html repeat the names for their pre-paint scripts.
export const THEMES = [
  'light',
  'dark',
  'snow',
  'candy',
  'mint',
  'retro',
  'midnight',
  'synthwave',
  'bloodmoon',
  'coffee',
  'batman',
  'mono',
] as const;
// Why the page refused a move or an action of the player.
export const REFUSALS = ['occupied', 'game-over', 'wait', 'not-your-turn', 'spectator', 'reviewing', 'viewing', 'no-session', 'locked'] as const;
export type Refusal = (typeof REFUSALS)[number];
const DEVICE_KINDS = ['phone', 'tablet', 'computer'] as const satisfies readonly DeviceKind[];

// What the device saw during one game, for the stats page. Every field is required, so the
// server can tell a missing value from a zero.
export type Metrics = {
  device: DeviceKind;
  view: (typeof VIEWS)[number];
  layout: (typeof LAYOUTS)[number];
  theme: (typeof THEMES)[number];
  // Moves of the player at this device, by how they were placed.
  input: { board: number; keypad: number };
  refused: Partial<Record<Refusal, number>>;
  undos: number;
  // The thinking time of each computer move, in milliseconds.
  thinkMs: number[];
  // True when the device was offline at any move of the game.
  offline: boolean;
  // The name of the page script file, which carries the build hash, for example "index-B2x9kQ".
  version: string;
  // The computer settings of a tuned computer game, else null.
  tuning: Tuning | null;
  // A Nearby game: the role of this device and the kind of the other player's device.
  nearby: { role: 'host' | 'guest'; other: DeviceKind | null } | null;
};

// Size limits. A game has at most 64 moves, so no honest count comes near these.
export const MAX_COUNT = 10_000;
export const MAX_THINK_MS = 120_000;
const VERSION_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 64 && [...value].every((char) => VERSION_CHARS.includes(char));

// A version text that isVersion accepts: unknown characters dropped, at most 64 characters.
export function toVersion(text: string): string {
  const kept = [...text].filter((char) => VERSION_CHARS.includes(char)).join('').slice(0, 64);
  return kept === '' ? 'unknown' : kept;
}
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((option) => option === value);

const METRIC_KEYS = ['device', 'view', 'layout', 'theme', 'input', 'refused', 'undos', 'thinkMs', 'offline', 'version', 'tuning', 'nearby'];

// Refuses an unknown key, a missing key, a wrong type or a value out of range.
export function parseMetrics(value: unknown): Metrics | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, METRIC_KEYS) || !METRIC_KEYS.every((key) => key in value)) return undefined;
  const { input, refused, undos, thinkMs, offline, version, tuning, nearby } = value;
  const device = oneOf(DEVICE_KINDS, value.device);
  const view = oneOf(VIEWS, value.view);
  const layout = oneOf(LAYOUTS, value.layout);
  const theme = oneOf(THEMES, value.theme);
  if (device === undefined || view === undefined || layout === undefined || theme === undefined) return undefined;
  if (!isRecord(input) || !hasOnlyKeys(input, ['board', 'keypad']) || !isCount(input.board) || !isCount(input.keypad)) return undefined;
  if (!isRecord(refused)) return undefined;
  const refusals: Metrics['refused'] = {};
  for (const [key, count] of Object.entries(refused)) {
    const reason = oneOf(REFUSALS, key);
    if (reason === undefined || !isCount(count)) return undefined;
    refusals[reason] = count;
  }
  if (!isCount(undos) || typeof offline !== 'boolean' || !isVersion(version)) return undefined;
  const validThink = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= MAX_THINK_MS;
  if (!isUnknownArray(thinkMs) || thinkMs.length > CELL_COUNT || !thinkMs.every(validThink)) return undefined;
  if (tuning !== null && !isTuning(tuning)) return undefined;
  let nearbyInfo: Metrics['nearby'] = null;
  if (nearby !== null) {
    if (!isRecord(nearby) || !hasOnlyKeys(nearby, ['role', 'other'])) return undefined;
    const role = oneOf(['host', 'guest'] as const, nearby.role);
    const other = nearby.other === null ? null : oneOf(DEVICE_KINDS, nearby.other);
    if (role === undefined || other === undefined) return undefined;
    nearbyInfo = { role, other };
  }
  return {
    device,
    view,
    layout,
    theme,
    input: { board: input.board, keypad: input.keypad },
    refused: refusals,
    undos,
    thinkMs: [...thinkMs],
    offline,
    version,
    tuning: tuning === null ? null : parseTuning(tuning),
    nearby: nearbyInfo,
  };
}

// ---- Results ----

// A finished computer, friend or Nearby game, sent by the device that played it.
// `id` is made on the device, so sending the same result twice stores it once. It holds the
// player token, so it never leaves the server. `publicId` is the id for the game link.
export type ResultUpload = {
  id: string;
  mode: Exclude<SessionMode, 'online'>;
  game: GameRecord;
  // The seat of this device's player. Null for a friend game, where one device plays both seats.
  you: Player | null;
  difficulty: Difficulty | null;
  finishedAt: EpochMs;
  // Null from a device version before game links. The server then makes an id.
  publicId: DeviceGameId | null;
  // The hide settings at the end of the game.
  options: MatchOptions;
  // True for a computer game against changed advanced settings.
  tuned: boolean;
  metrics: Metrics | null;
  // A Nearby game from the host: the player token of the guest on the other seat, else null. The
  // server stores it as that seat, so the guest's history has the game. It never leaves the server.
  guest: PlayerToken | null;
};

// One upload carries at most this many results. A device sends more in several requests.
export const RESULTS_PER_UPLOAD = 100;

const RESULT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';

// A result can finish at most this far in the future, to allow for a device clock that runs fast.
const FUTURE_SLACK_MS = 86_400_000;

const RESULT_KEYS = ['id', 'mode', 'game', 'you', 'difficulty', 'finishedAt', 'publicId', 'options', 'tuned', 'metrics', 'guest'];

// `now` is the time of the reader. The database can store finishedAt only inside a bounded range.
// A device version before game links sends no publicId, options, tuned or metrics, and a version
// before generated names sends no guest. Those get their defaults, so its waiting results still upload.
export function parseResultUpload(value: unknown, now: EpochMs): ResultUpload | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, RESULT_KEYS)) return undefined;
  const { id, mode, game, you, difficulty, finishedAt } = value;
  if (typeof id !== 'string' || id.length < 16 || id.length > 64 || ![...id].every((c) => RESULT_ID_CHARS.includes(c))) {
    return undefined;
  }
  if (mode !== 'computer' && mode !== 'friend' && mode !== 'nearby') return undefined;
  if (!isGameRecord(game)) return undefined;
  // Only finished games count. Replaying also proves every move is legal.
  let finished: Game;
  try {
    finished = toGame(game);
  } catch {
    return undefined;
  }
  if (finished.status.kind === 'playing') return undefined;
  if (you !== null && you !== 'X' && you !== 'O') return undefined;
  if (mode === 'friend' ? you !== null : you === null) return undefined;
  const level = difficulty === null ? null : DIFFICULTIES.find((d) => d === difficulty);
  if (level === undefined || (mode === 'computer') !== (level !== null)) return undefined;
  if (!isEpochMs(finishedAt) || finishedAt === 0 || finishedAt > now + FUTURE_SLACK_MS) return undefined;
  const publicId = value.publicId === undefined || value.publicId === null ? null : parseDeviceGameId(value.publicId);
  if (publicId === undefined) return undefined;
  const options = parseMatchOptions(value.options ?? { hideBoard: false, hideHistory: false });
  if (options === undefined) return undefined;
  const tuned = value.tuned ?? false;
  if (typeof tuned !== 'boolean' || (tuned && mode !== 'computer')) return undefined;
  const metrics = value.metrics === undefined || value.metrics === null ? null : parseMetrics(value.metrics);
  if (metrics === undefined) return undefined;
  // Only a Nearby host names a second seat: the guest's.
  const guest = value.guest === undefined || value.guest === null ? null : asPlayerToken(value.guest);
  if (guest === undefined || (guest !== null && (mode !== 'nearby' || you === null))) return undefined;
  return {
    id,
    mode,
    game,
    you,
    difficulty: level,
    finishedAt,
    publicId,
    options,
    tuned,
    metrics,
    guest,
  };
}

// ---- One game, read-only ----

// A finished game as anybody with its link sees it. It has no tokens and no result id.
// An online game has an online id ("<CODE>-<n>"), every other game a device id.
export type PublicGame = (
  | { id: OnlineGameId; mode: 'online' }
  | { id: DeviceGameId; mode: Exclude<SessionMode, 'online'> }
) &
  PublicGameFields;
type PublicGameFields = {
  game: GameRecord;
  options: MatchOptions;
  difficulty: Difficulty | null;
  tuned: boolean;
  // The computer's seat, in a computer game.
  computer: Player | null;
  // The GitHub account behind each seat, when its player logged in.
  players: Record<Player, PlayerInfo | null>;
  names: SeatNames;
  finishedAt: EpochMs;
};

// Throws on any unexpected shape. The server checks its own answer with this too.
export function parsePublicGame(value: unknown): PublicGame {
  const fail = (field: string): never => {
    throw new Error(`invalid game from server: ${field}`);
  };
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'mode', 'game', 'options', 'difficulty', 'tuned', 'computer', 'players', 'names', 'finishedAt'])) {
    return fail('body');
  }
  const id = parseGameId(value.id);
  const mode = oneOf(SESSION_MODES, value.mode);
  const { game, options, tuned, computer, players, finishedAt } = value;
  const difficulty = value.difficulty === null ? null : oneOf(DIFFICULTIES, value.difficulty);
  if (id === undefined || id !== value.id) return fail('id');
  if (mode === undefined) return fail('mode');
  if (!isGameRecord(game) || toGame(game).status.kind === 'playing') return fail('game');
  const matchOptions = parseMatchOptions(options);
  if (matchOptions === undefined) return fail('options');
  if (difficulty === undefined || (mode === 'computer') !== (difficulty !== null)) return fail('difficulty');
  if (typeof tuned !== 'boolean') return fail('tuned');
  if (computer !== null && computer !== 'X' && computer !== 'O') return fail('computer');
  if ((mode === 'computer') !== (computer !== null)) return fail('computer');
  if (!isRecord(players)) return fail('players');
  const playerX = players.X === null ? null : parsePlayerInfo(players.X);
  const playerO = players.O === null ? null : parsePlayerInfo(players.O);
  if (playerX === undefined || playerO === undefined) return fail('players');
  const names = parseSeatNames(value.names);
  if (names === undefined) return fail('names');
  if (!isEpochMs(finishedAt)) return fail('finishedAt');
  const fields: PublicGameFields = {
    game: { moves: game.moves, times: game.times, clock: game.clock, timedOut: game.timedOut },
    options: matchOptions,
    difficulty,
    tuned,
    computer,
    players: { X: playerX, O: playerO },
    names,
    finishedAt,
  };
  if (mode === 'online') return isOnlineGameId(id) ? { id, mode, ...fields } : fail('id');
  return isOnlineGameId(id) ? fail('id') : { id, mode, ...fields };
}

// ---- Match history ----

// The result of a game for the player who asks. A friend game is only "played": one device held both seats.
export type Outcome = 'won' | 'lost' | 'drawn' | 'played';
export type HistoryEntry = {
  // Null for a game stored before game links: it has no link.
  id: GameId | null;
  mode: SessionMode;
  difficulty: Difficulty | null;
  result: Outcome;
  moves: number;
  // The GitHub account of the other player, when there is one.
  opponent: PlayerInfo | null;
  // The generated name of the other player, when the server knows their seat.
  opponentName: string | null;
  finishedAt: EpochMs;
};
export type HistoryPage = { games: HistoryEntry[]; more: boolean };
export const HISTORY_PAGE_SIZE = 50;

const OUTCOMES = ['won', 'lost', 'drawn', 'played'] as const;

export function parseHistoryPage(value: unknown): HistoryPage {
  const fail = (field: string): never => {
    throw new Error(`invalid history from server: ${field}`);
  };
  if (!isRecord(value) || !Array.isArray(value.games) || typeof value.more !== 'boolean') return fail('body');
  const games = value.games.map((entry: unknown): HistoryEntry => {
    if (!isRecord(entry)) return fail('entry');
    const id = entry.id === null ? null : parseGameId(entry.id);
    const mode = oneOf(SESSION_MODES, entry.mode);
    const difficulty = entry.difficulty === null ? null : oneOf(DIFFICULTIES, entry.difficulty);
    const result = oneOf(OUTCOMES, entry.result);
    const opponent = entry.opponent === null ? null : parsePlayerInfo(entry.opponent);
    const { moves, finishedAt, opponentName } = entry;
    if (id === undefined || mode === undefined || difficulty === undefined || result === undefined || opponent === undefined) {
      return fail('entry');
    }
    if (!isCount(moves) || !isEpochMs(finishedAt) || !isSeatName(opponentName)) return fail('entry');
    return { id, mode, difficulty, result, moves, opponent, opponentName, finishedAt };
  });
  return { games, more: value.more };
}

// ---- Client events ----

// A fault on a page, for the failures list of the stats page: an uncaught error, a promise that
// nobody caught, or a burst of refused moves (a sign of a confusing screen).
const EVENT_KINDS = ['error', 'rejection', 'refusals'] as const;
export type ClientEvent = { kind: (typeof EVENT_KINDS)[number]; message: string; version: string };
const EVENT_MESSAGE_MAX_LENGTH = 300;

export function parseClientEvent(value: unknown): ClientEvent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'message', 'version'])) return undefined;
  const kind = oneOf(EVENT_KINDS, value.kind);
  const { message, version } = value;
  if (kind === undefined || !isVersion(version)) return undefined;
  if (typeof message !== 'string' || message.length < 1 || message.length > EVENT_MESSAGE_MAX_LENGTH) return undefined;
  return { kind, message, version };
}

// ---- My games ----

export type Tally = { played: number; won: number; lost: number; drawn: number };
export type SessionSummary = {
  code: Code;
  name: string;
  games: number;
  you: Player;
  opponent: PlayerInfo | null;
  // The generated name of the other player. Null while their seat is empty.
  opponentName: string | null;
  yourTurn: boolean;
  updatedAt: EpochMs;
};
export type MyGames = {
  user: PlayerInfo | null;
  total: Tally;
  byMode: Record<SessionMode, Tally>;
  byDifficulty: Record<Difficulty, Tally>;
  sessions: SessionSummary[];
};

// ---- Stats ----

// The aggregates of the public stats page (/stats). Counts only: never a token, a result id, a game id
// or a page fault. Only `personal` (Mine) names players: your opponents.
export type Count = { key: string; count: number };
export type Stats = {
  generatedAt: EpochMs;
  totals: { games: number; moves: number; players: number; accounts: number; sessions: number; gamesLast7Days: number };
  // The last 60 days, oldest first, in UTC.
  perDay: { day: string; games: number; players: number }[];
  // Day 0 is Monday. UTC.
  hours: { day: number; hour: number; games: number }[];
  byMode: Count[];
  // Against the computer, from the player's side.
  levels: { level: Difficulty; games: number; won: number; drawn: number; lost: number; avgMoves: number; medianMoves: number; tuned: number }[];
  lengthByMode: { mode: SessionMode; games: number; avg: number; median: number; p90: number }[];
  // Time between two moves, in buckets (MOVE_TIME_BUCKETS).
  moveTimes: { bucket: number; human: number; computer: number }[];
  // Median time per move in milliseconds, per computer level and per other mode. `searchMs` is the
  // computer's own thinking time that devices report, without the pause before its move.
  thinkTimes: { key: string; humanMs: number | null; computerMs: number | null; searchMs: number | null }[];
  firstPlayer: { mode: SessionMode; x: number; o: number; draws: number }[];
  // CELL_COUNT counts each: first moves, and all moves.
  openings: number[];
  cells: number[];
  // How games end: axis, plane, space (the kind of the winning line), timeout or draw.
  endings: Count[];
  // `coordinates` is true for the games with hidden coordinates, on top of `setting`.
  hide: { setting: 'none' | 'board' | 'history' | 'both'; coordinates: boolean; games: number; computerGames: number; humanWins: number }[];
  timeLimits: { perGame: number | null; perMove: number | null; games: number }[];
  tuned: { tuned: boolean; games: number; humanWins: number }[];
  // From game metrics: device results, and each player of an online game (one report per seat).
  metricsGames: number;
  devices: Count[];
  views: Count[];
  layouts: Count[];
  themes: Count[];
  versions: Count[];
  input: { board: number; keypad: number };
  refusals: Count[];
  undo: { gamesWithUndo: number; undos: number };
  offlineGames: number;
  nearbyMixes: Count[];
  // The filters that made these numbers.
  filter: StatsFilter;
  // The win rate over time, oldest first: at each game, the share of wins in the FORM_WINDOW games up to it.
  // Mine: your games with a side. Everyone: the games against the computer, from the player's side.
  form: { at: EpochMs; rate: number }[];
  // Games per number of moves: index n holds the games with n moves (0 to CELL_COUNT).
  lengths: number[];
  // CELL_COUNT counts: the games that X won, by the first move. Next to `openings`.
  openingWinsX: number[];
  // Only for Mine. null for Everyone.
  personal: PersonalStats | null;
  // The sound practice room: runs and leaderboards (server/practice.ts).
  practice: PracticeStats;
};

// A game result from the side of one player. A friend game has no side.
export type SideOutcome = Exclude<Outcome, 'played'>;
export type PersonalStats = {
  // Your survival records: per level, the most moves of a game that the default computer won.
  survival: { level: Difficulty; moves: number }[];
  // Per mode, and per level in computer games. Friend games have no side, so they are not here.
  results: { mode: SessionMode; level: Difficulty | null; won: number; drawn: number; lost: number }[];
  // The longest run of won games, and the run of equal results that ends with the newest game.
  bestStreak: number;
  currentStreak: { outcome: SideOutcome; length: number } | null;
  // The players you played most, with your results against them. `player` is a name, never a token.
  opponents: { player: string; games: number; won: number; drawn: number; lost: number }[];
};

export const FORM_WINDOW = 20;

// ---- Stats filters ----

// The filters of the stats page. The page keeps them in its address, and GET /api/stats takes the
// same query. A missing key means its default: everyone, all time, every mode and level.
export const STATS_SCOPES = ['everyone', 'mine'] as const;
export const STATS_RANGES = ['7d', '30d', 'all'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
export type StatsFilter = {
  scope: (typeof STATS_SCOPES)[number];
  range: StatsRange;
  // null: every mode or every level. A level matches computer games only.
  mode: SessionMode | null;
  level: Difficulty | null;
};
export const ALL_STATS: StatsFilter = { scope: 'everyone', range: 'all', mode: null, level: null };
export const RANGE_DAYS: Record<StatsRange, number | null> = { '7d': 7, '30d': 30, all: null };
const STATS_KEYS = ['scope', 'range', 'mode', 'level'] as const;

// Refuses an unknown key, a repeated key, an unknown or empty value, and a level with a mode other than computer.
export function parseStatsFilter(params: URLSearchParams): StatsFilter | undefined {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || !keys.every((key) => STATS_KEYS.some((known) => known === key))) return undefined;
  const pick = <T extends string>(key: (typeof STATS_KEYS)[number], options: readonly T[]): T | null | undefined => {
    const value = params.get(key);
    return value === null ? null : oneOf(options, value);
  };
  const scope = pick('scope', STATS_SCOPES);
  const range = pick('range', STATS_RANGES);
  const mode = pick('mode', SESSION_MODES);
  const level = pick('level', DIFFICULTIES);
  if (scope === undefined || range === undefined || mode === undefined || level === undefined) return undefined;
  if (level !== null && mode !== null && mode !== 'computer') return undefined;
  return { scope: scope ?? ALL_STATS.scope, range: range ?? ALL_STATS.range, mode, level };
}

// The query of a filter, with "?" first, or '' for the defaults. A default value stays out, so one view has one address.
export function statsQuery(filter: StatsFilter): string {
  const params = new URLSearchParams();
  if (filter.scope !== ALL_STATS.scope) params.set('scope', filter.scope);
  if (filter.range !== ALL_STATS.range) params.set('range', filter.range);
  if (filter.mode !== null) params.set('mode', filter.mode);
  if (filter.level !== null) params.set('level', filter.level);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export const MOVE_TIME_BUCKETS = ['< 1 s', '1–2 s', '2–5 s', '5–10 s', '10–30 s', '30–60 s', '1–5 min', '5 min +'] as const;

export function outcomeOf(winner: Player | null, you: Player | null): Outcome {
  if (you === null) return 'played';
  return winner === null ? 'drawn' : winner === you ? 'won' : 'lost';
}

// ---- Previews ----

// GET /api/previews: the open pull requests with a live preview (server/previews.ts).
export type Contributor = PlayerInfo & { url: string };
export type Preview = {
  number: number;
  title: string;
  // The first paragraph of the pull request body as plain text.
  description: string;
  // The pull request on GitHub.
  url: string;
  previewUrl: string;
  updatedAt: EpochMs;
  draft: boolean;
  // The author of the pull request and the commit authors, most commits first.
  contributors: Contributor[];
  // A stacked pull request: the number of the listed pull request whose head branch is its base branch. null when it is top level.
  parent: number | null;
};
// `main` is the production site, built from the main branch. null on a server without previews.
// `error` says why the list is empty or old. null when the list is fresh.
export type Previews = { main: string | null; previews: Preview[]; error: string | null };
export const PREVIEW_DESCRIPTION_LENGTH = 280;

function parseContributor(value: unknown): Contributor | undefined {
  const info = parsePlayerInfo(value);
  if (info === undefined || !isRecord(value) || value.url !== `https://github.com/${info.login}`) return undefined;
  return { ...info, url: value.url };
}

function parsePreview(value: unknown): Preview | undefined {
  if (!isRecord(value)) return undefined;
  const { number, title, description, url, previewUrl, updatedAt, draft, contributors } = value;
  // A production server from before stacked pull requests sends no parent.
  const parent = value.parent ?? null;
  if (parent !== null && (typeof parent !== 'number' || !Number.isInteger(parent) || parent < 1 || parent === number)) return undefined;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return undefined;
  if (typeof title !== 'string' || typeof description !== 'string' || description.length > PREVIEW_DESCRIPTION_LENGTH) return undefined;
  // The page puts both addresses in links, so each must go to the expected kind of site.
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) return undefined;
  if (typeof previewUrl !== 'string' || !previewUrl.startsWith(`https://pr.${number}.`)) return undefined;
  if (!isEpochMs(updatedAt) || typeof draft !== 'boolean' || !Array.isArray(contributors)) return undefined;
  const people = contributors.map(parseContributor);
  if (!people.every((person) => person !== undefined)) return undefined;
  return { number, title, description, url, previewUrl, updatedAt, draft, contributors: people, parent };
}

export function parsePreviews(value: unknown): Previews {
  if (!isRecord(value) || !Array.isArray(value.previews) || !(value.error === null || typeof value.error === 'string')) {
    throw new Error('invalid answer from /api/previews');
  }
  // The page puts the address in a link, so it must be a secure site.
  if (!(value.main === null || (typeof value.main === 'string' && value.main.startsWith('https://')))) {
    throw new Error('invalid answer from /api/previews');
  }
  const previews = value.previews.map(parsePreview);
  if (!previews.every((preview) => preview !== undefined)) throw new Error('invalid preview from /api/previews');
  return { main: value.main, previews, error: value.error };
}

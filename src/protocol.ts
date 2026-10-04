// Contract between the page and the online API. Both sides import this file.
import { DIFFICULTIES, type Difficulty } from './ai.ts';
import { type TimeControl, parseClock } from './clock.ts';
import { CELL_COUNT, type Game, type Player, replay, timeOut } from './game.ts';

// Letters and digits without the look-alikes 0/O and 1/I, so a code read aloud is not ambiguous.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
export const NAME_MAX_LENGTH = 40;
// Sessions and games per session have no limit. Add one when storage use calls for it.
export const CHAT_MAX_LENGTH = 200;
// A session keeps its newest messages only.
export const CHAT_KEEP = 50;

export type Code = string & { readonly __brand: 'Code' };
export type PlayerToken = string & { readonly __brand: 'PlayerToken' };

// Match options apply to both players and to watchers. View and layout stay per screen.
export type MatchOptions = { hideBoard: boolean; hideHistory: boolean };

export type ChatMessage = { id: number; from: Player; text: string; at: number };
// A GitHub account linked to a seat. Shown next to the seat, never required to play.
export type PlayerInfo = { login: string; avatar: string };
export const SESSION_MODES = ['online', 'computer', 'friend', 'nearby'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
// One game as stored: moves, the time of each move, its time limit, and whether the player to move ran out of time.
export type GameRecord = { moves: number[]; times: number[]; clock: TimeControl; timedOut: boolean };

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
  // Server time when the view was made. Pages use it to correct their own clock.
  now: number;
  version: number;
  // Oldest first. Only the two players can write, everybody with the code can read.
  chat: ChatMessage[];
  // Which seats have the session open right now. A seat that is away still plays: moves wait for it.
  presence: Record<Player, boolean>;
  // The GitHub account behind each seat, when its player logged in.
  players: Record<Player, PlayerInfo | null>;
};

export type SessionUpdate = { name?: string; clock?: TimeControl } & Partial<MatchOptions>;

export function toGame(record: GameRecord): Game {
  const game = replay(record.moves, { times: record.times, clock: record.clock });
  return record.timedOut ? timeOut(game) : game;
}

export function toRecord(game: Game): GameRecord {
  return { moves: [...game.moves], times: [...game.times], clock: game.clock, timedOut: game.status.kind === 'timeout' };
}

export type MoveRequest = { game: number; moveCount: number; cell: number };

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

// A token is a crypto.randomUUID() kept in the browser. It proves which seat a browser holds.
export function asPlayerToken(input: unknown): PlayerToken | undefined {
  if (typeof input !== 'string' || input.length < 16 || input.length > 64) return undefined;
  return [...input].every((char) => TOKEN_CHARS.includes(char)) ? (input as PlayerToken) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCell = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CELL_COUNT;

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  const { id, from, text, at } = value;
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    (from === 'X' || from === 'O') &&
    normalizeChat(text) === text &&
    typeof at === 'number' &&
    Number.isFinite(at)
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
    times.every((time) => typeof time === 'number' && Number.isFinite(time)) &&
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
  const known = ['name', 'hideBoard', 'hideHistory', 'clock'];
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
  for (const option of ['hideBoard', 'hideHistory'] as const) {
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
  const clock = parseClock(value.clock);
  if (code === undefined) return fail('code');
  if (name === undefined) return fail('name');
  if (!Array.isArray(games) || games.length === 0 || !games.every(isGameRecord)) return fail('games');
  if (!isRecord(seats) || typeof seats.X !== 'boolean' || typeof seats.O !== 'boolean') return fail('seats');
  if (you !== null && you !== 'X' && you !== 'O') return fail('you');
  if (!isRecord(options) || typeof options.hideBoard !== 'boolean' || typeof options.hideHistory !== 'boolean') {
    return fail('options');
  }
  if (typeof locked !== 'boolean') return fail('locked');
  if (clock === undefined) return fail('clock');
  if (typeof now !== 'number' || !Number.isFinite(now)) return fail('now');
  if (typeof version !== 'number' || !Number.isInteger(version)) return fail('version');
  if (!Array.isArray(chat) || chat.length > CHAT_KEEP || !chat.every(isChatMessage)) return fail('chat');
  if (!isRecord(presence) || typeof presence.X !== 'boolean' || typeof presence.O !== 'boolean') return fail('presence');
  if (!isRecord(players)) return fail('players');
  const playerX = players.X === null ? null : parsePlayerInfo(players.X);
  const playerO = players.O === null ? null : parsePlayerInfo(players.O);
  if (playerX === undefined || playerO === undefined) return fail('players');
  return {
    code,
    name,
    games,
    seats: { X: seats.X, O: seats.O },
    you,
    options: { hideBoard: options.hideBoard, hideHistory: options.hideHistory },
    locked,
    clock,
    now,
    version,
    chat: chat.map(({ id, from, text, at }) => ({ id, from, text, at })),
    presence: { X: presence.X, O: presence.O },
    players: { X: playerX, O: playerO },
  };
}

const GITHUB_LOGIN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

export function parsePlayerInfo(value: unknown): PlayerInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { login, avatar } = value;
  if (typeof login !== 'string' || login.length < 1 || login.length > 39) return undefined;
  if (![...login].every((char) => GITHUB_LOGIN_CHARS.includes(char))) return undefined;
  // Avatars come from GitHub only, so a page never loads an image from an address a player chose.
  if (typeof avatar !== 'string' || !avatar.startsWith('https://avatars.githubusercontent.com/')) return undefined;
  return { login, avatar };
}

// ---- Results of games played away from the server ----

// A finished computer, friend or Nearby game, sent by the device that played it.
// `id` is made on the device, so sending the same result twice stores it once.
export type ResultUpload = {
  id: string;
  mode: Exclude<SessionMode, 'online'>;
  game: GameRecord;
  // The seat of this device's player. Null for a friend game, where one device plays both seats.
  you: Player | null;
  difficulty: Difficulty | null;
  finishedAt: number;
};

// One upload carries at most this many results. A device sends more in several requests.
export const RESULTS_PER_UPLOAD = 100;

const RESULT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';

export function parseResultUpload(value: unknown): ResultUpload | undefined {
  if (!isRecord(value)) return undefined;
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
  if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return undefined;
  return { id, mode, game, you, difficulty: level, finishedAt };
}

// ---- My games ----

export type Tally = { played: number; won: number; lost: number; drawn: number };
export type SessionSummary = {
  code: Code;
  name: string;
  games: number;
  you: Player;
  opponent: PlayerInfo | null;
  yourTurn: boolean;
  updatedAt: number;
};
export type MyGames = {
  user: PlayerInfo | null;
  total: Tally;
  byMode: Record<SessionMode, Tally>;
  byDifficulty: Record<Difficulty, Tally>;
  sessions: SessionSummary[];
};

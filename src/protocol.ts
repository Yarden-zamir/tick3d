// Contract between the page and the online API. Both sides import this file.
import { CELL_COUNT, type Player } from './game.ts';

// Letters and digits without the look-alikes 0/O and 1/I, so a code read aloud is not ambiguous.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
export const NAME_MAX_LENGTH = 40;
export const MAX_SESSIONS = 10_000;
// Each game holds at most 64 moves, so this caps one session row at about 100 kB.
export const MAX_GAMES_PER_SESSION = 500;

export type Code = string & { readonly __brand: 'Code' };
export type PlayerToken = string & { readonly __brand: 'PlayerToken' };

// Match options apply to both players and to watchers. View and layout stay per screen.
export type MatchOptions = { hideBoard: boolean; hideHistory: boolean };

export type SessionView = {
  code: Code;
  name: string;
  games: number[][];
  seats: Record<Player, boolean>;
  you: Player | null;
  options: MatchOptions;
  // True while a lock holds: from the lock until the live game ends.
  locked: boolean;
  version: number;
};

export type SessionUpdate = { name?: string } & Partial<MatchOptions>;

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

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-';

// A token is a crypto.randomUUID() kept in the browser. It proves which seat a browser holds.
export function asPlayerToken(input: unknown): PlayerToken | undefined {
  if (typeof input !== 'string' || input.length < 16 || input.length > 64) return undefined;
  return [...input].every((char) => TOKEN_CHARS.includes(char)) ? (input as PlayerToken) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCell = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CELL_COUNT;

export function isMoveList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= CELL_COUNT && value.every(isCell);
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
  const known = ['name', 'hideBoard', 'hideHistory'];
  if (keys.length === 0 || !keys.every((key) => known.includes(key))) return undefined;
  const update: SessionUpdate = {};
  if ('name' in value) {
    const name = normalizeName(value.name);
    if (name === undefined) return undefined;
    update.name = name;
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
  const { games, seats, you, options, locked, version } = value;
  if (code === undefined) return fail('code');
  if (name === undefined) return fail('name');
  if (!Array.isArray(games) || games.length === 0 || !games.every(isMoveList)) return fail('games');
  if (!isRecord(seats) || typeof seats.X !== 'boolean' || typeof seats.O !== 'boolean') return fail('seats');
  if (you !== null && you !== 'X' && you !== 'O') return fail('you');
  if (!isRecord(options) || typeof options.hideBoard !== 'boolean' || typeof options.hideHistory !== 'boolean') {
    return fail('options');
  }
  if (typeof locked !== 'boolean') return fail('locked');
  if (typeof version !== 'number' || !Number.isInteger(version)) return fail('version');
  return {
    code,
    name,
    games,
    seats: { X: seats.X, O: seats.O },
    you,
    options: { hideBoard: options.hideBoard, hideHistory: options.hideHistory },
    locked,
    version,
  };
}

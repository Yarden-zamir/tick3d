// The stored format of one session. The database keeps each session as one document, so the
// table never changes shape when the session format does.
//
// How to change the format:
// 1. A new optional field: give it a default in parseDoc. Old documents read fine, nothing else to do.
// 2. A change that old documents cannot satisfy by a default (a rename, a new meaning):
//    increase CURRENT_FORMAT and add UPGRADES[old] that turns an old document into the new one.
//    Documents upgrade when they are read and are written back in the current format.
// 3. Never edit an UPGRADES step after release. Documents in that format can still exist.
// fixtures/format-1.json holds a real format 1 document. Its test proves that old data still reads.
import { DIFFICULTIES, type Difficulty } from '../ai.ts';
import { NO_LIMIT, type TimeControl, parseClock } from '../clock.ts';
import type { Player } from '../game.ts';
import {
  CHAT_KEEP,
  type ChatMessage,
  type GameRecord,
  type MatchOptions,
  SESSION_MODES,
  type SessionMode,
  isChatMessage,
  isMoveList,
  normalizeName,
  toGame,
} from '../protocol.ts';

export const CURRENT_FORMAT = 1;

export type SessionDoc = {
  format: typeof CURRENT_FORMAT;
  // Where the session runs: the server (online), or one device (computer, friend, a Nearby host).
  mode: SessionMode;
  // The computer's level and seat, in a computer game only.
  computer: { difficulty: Difficulty; seat: Player } | null;
  name: string;
  games: GameRecord[];
  // Player tokens. Never sent to a page.
  seats: Record<Player, string | null>;
  options: MatchOptions;
  // Index of the game that the lock holds. The lock ends when that game ends.
  lockedGame: number | null;
  // The time limit for the next game.
  clock: TimeControl;
  // Oldest first, the newest CHAT_KEEP messages only.
  chat: ChatMessage[];
};

type RawDoc = Record<string, unknown>;
export type Upgrade = (doc: RawDoc) => RawDoc;

// UPGRADES[n] turns a format n document into format n + 1. Empty until the first breaking change.
const UPGRADES: Readonly<Record<number, Upgrade>> = {};

export class FormatError extends Error {}

const isRecord = (value: unknown): value is RawDoc => typeof value === 'object' && value !== null && !Array.isArray(value);

function readGame(value: unknown, index: number): GameRecord {
  if (!isRecord(value) || !isMoveList(value.moves)) throw new FormatError(`game ${index} has no valid moves`);
  const moves = value.moves;
  const times = Array.isArray(value.times) ? value.times : moves.map(() => 0);
  if (times.length !== moves.length || !times.every((time) => typeof time === 'number' && Number.isFinite(time))) {
    throw new FormatError(`game ${index} has invalid move times`);
  }
  const clock = value.clock === undefined ? NO_LIMIT : parseClock(value.clock);
  if (clock === undefined) throw new FormatError(`game ${index} has an invalid clock`);
  const record: GameRecord = { moves, times, clock, timedOut: value.timedOut === true };
  // Replay the game, so a stored game with an illegal move or a timeout after its end never loads.
  try {
    toGame(record);
  } catch (error) {
    throw new FormatError(`game ${index} does not replay: ${error instanceof Error ? error.message : String(error)}`);
  }
  return record;
}

function readSeat(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new FormatError('a seat is not a player token');
  return value;
}

// Reads a stored document of any known format. Missing optional fields get their defaults.
// Throws on a document from a newer version, so an old server never overwrites newer data.
export function parseDoc(stored: unknown, upgrades: Readonly<Record<number, Upgrade>> = UPGRADES, current: number = CURRENT_FORMAT): SessionDoc {
  if (!isRecord(stored)) throw new FormatError('a session document must be an object');
  let doc = stored;
  let format = doc.format === undefined ? 1 : doc.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) throw new FormatError(`unknown format ${JSON.stringify(format)}`);
  if (format > current) throw new FormatError(`format ${format} is newer than this server (${current})`);
  while (format < current) {
    const upgrade = upgrades[format];
    if (upgrade === undefined) throw new FormatError(`no upgrade from format ${format}`);
    doc = upgrade(doc);
    format++;
  }

  const name = normalizeName(doc.name);
  if (name === undefined) throw new FormatError('the session name is missing or invalid');
  if (!Array.isArray(doc.games) || doc.games.length === 0) throw new FormatError('a session needs at least one game');
  const seats = isRecord(doc.seats) ? doc.seats : {};
  const options = isRecord(doc.options) ? doc.options : {};
  const clock = doc.clock === undefined ? NO_LIMIT : parseClock(doc.clock);
  if (clock === undefined) throw new FormatError('the session clock is invalid');
  const lockedGame = typeof doc.lockedGame === 'number' && Number.isInteger(doc.lockedGame) ? doc.lockedGame : null;
  const mode = doc.mode === undefined ? 'online' : SESSION_MODES.find((known) => known === doc.mode);
  if (mode === undefined) throw new FormatError(`unknown session mode ${String(doc.mode)}`);
  const chat = doc.chat === undefined ? [] : doc.chat;
  if (!Array.isArray(chat) || !chat.every(isChatMessage)) throw new FormatError('the chat is invalid');
  return {
    format: CURRENT_FORMAT,
    mode,
    computer: readComputer(doc.computer, mode),
    name,
    games: doc.games.map(readGame),
    seats: { X: readSeat(seats.X), O: readSeat(seats.O) },
    options: { hideBoard: options.hideBoard === true, hideHistory: options.hideHistory === true },
    lockedGame,
    clock,
    chat: chat.slice(-CHAT_KEEP),
  };
}

function readComputer(value: unknown, mode: SessionMode): SessionDoc['computer'] {
  if (mode !== 'computer') return null;
  if (!isRecord(value)) throw new FormatError('a computer game needs its computer settings');
  const difficulty = DIFFICULTIES.find((level) => level === value.difficulty);
  const seat = value.seat === 'X' || value.seat === 'O' ? value.seat : undefined;
  if (difficulty === undefined || seat === undefined) throw new FormatError('the computer settings are invalid');
  return { difficulty, seat };
}

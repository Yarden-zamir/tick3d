// A sound playoff inside an online session: both players run the same seeded targets at the same time,
// and the faster total wins. The session document keeps it (an optional field, see src/session/format.ts),
// so the existing event stream and long poll carry every change to both pages.
// Limit: each page reports its own target times, and the server cannot check them. That is fine for a
// friendly playoff. Revisit this if playoffs ever count for a public ranking.
import type { Player } from '../game.ts';
import { MAX_ROUND_MS, PRESET_IDS, type PresetId, ROUNDS } from './practice.ts';
import { isRecord } from '../guards.ts';

// The countdown after both players joined, so both pages start together.
export const PLAYOFF_COUNTDOWN_MS = 3000;
export const PLAYOFF_TARGETS = ROUNDS.targets;

// `times` holds the time of each target that the player hit, in order.
type PlayoffSeat = { joined: boolean; times: number[] };
// `ended`: done (both finished), declined (the other player said not now), left (a player stopped).
type PlayoffEnd = 'done' | 'declined' | 'left';

export type Playoff = {
  // Grows with each playoff of the session, so a late request for an older playoff does nothing.
  id: number;
  seed: number;
  preset: PresetId;
  by: Player;
  seats: Record<Player, PlayoffSeat>;
  // Server time when the targets start, once both joined. null before.
  startAt: number | null;
  ended: PlayoffEnd | null;
};

export type PlayoffRequest =
  | { action: 'start'; preset: PresetId; seed: number }
  | { action: 'join'; id: number }
  | { action: 'leave'; id: number }
  | { action: 'hit'; id: number; index: number; ms: number };

export class PlayoffError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isWhole = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const ENDS: readonly PlayoffEnd[] = ['done', 'declined', 'left'];

function parseSeat(value: unknown): PlayoffSeat | undefined {
  if (!isRecord(value) || typeof value.joined !== 'boolean' || !Array.isArray(value.times)) return undefined;
  const times = value.times;
  if (times.length > PLAYOFF_TARGETS || !times.every((time) => isWhole(time, MAX_ROUND_MS))) return undefined;
  return { joined: value.joined, times: [...times] };
}

// Reads a playoff from a stored document or a session view. undefined for anything else.
export function parsePlayoff(value: unknown): Playoff | undefined {
  if (!isRecord(value) || !isRecord(value.seats)) return undefined;
  const { id, seed, preset, by, startAt, ended } = value;
  const x = parseSeat(value.seats.X);
  const o = parseSeat(value.seats.O);
  const presetId = PRESET_IDS.find((known) => known === preset);
  const end = ended === null ? null : ENDS.find((known) => known === ended);
  if (!isWhole(id, Number.MAX_SAFE_INTEGER) || !isWhole(seed, 2 ** 32 - 1) || presetId === undefined) return undefined;
  if ((by !== 'X' && by !== 'O') || x === undefined || o === undefined || end === undefined) return undefined;
  if (startAt !== null && (typeof startAt !== 'number' || !Number.isFinite(startAt))) return undefined;
  return { id, seed, preset: presetId, by, seats: { X: x, O: o }, startAt, ended: end };
}

export function parsePlayoffRequest(value: unknown): PlayoffRequest | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.action) {
    case 'start': {
      const preset = PRESET_IDS.find((known) => known === value.preset);
      return preset !== undefined && isWhole(value.seed, 2 ** 32 - 1) ? { action: 'start', preset, seed: value.seed } : undefined;
    }
    case 'join':
    case 'leave':
      return isWhole(value.id, Number.MAX_SAFE_INTEGER) ? { action: value.action, id: value.id } : undefined;
    case 'hit':
      return isWhole(value.id, Number.MAX_SAFE_INTEGER) && isWhole(value.index, PLAYOFF_TARGETS - 1) && isWhole(value.ms, MAX_ROUND_MS)
        ? { action: 'hit', id: value.id, index: value.index, ms: value.ms }
        : undefined;
    default:
      return undefined;
  }
}

const other = (player: Player): Player => (player === 'X' ? 'O' : 'X');
const total = (seat: PlayoffSeat) => seat.times.reduce((sum, time) => sum + time, 0);

// The winner of a finished playoff: the faster total, or null for a tie or a playoff that did not finish.
export function playoffWinner(playoff: Playoff): Player | null {
  if (playoff.ended !== 'done') return null;
  const x = total(playoff.seats.X);
  const o = total(playoff.seats.O);
  return x === o ? null : x < o ? 'X' : 'O';
}

// Applies one request of the player on `seat`. `bothSeated` is true when both seats have a player.
// Returns the new playoff, or the same object when nothing changes (a late request for an older playoff).
export function applyPlayoff(playoff: Playoff | null, seat: Player, bothSeated: boolean, request: PlayoffRequest, now: number): Playoff | null {
  if (request.action === 'start') {
    if (!bothSeated) throw new PlayoffError(409, 'A playoff needs a player on both seats.');
    if (playoff !== null && playoff.ended === null && playoff.startAt !== null && now < playoff.startAt + PLAYOFF_TARGETS * MAX_ROUND_MS) {
      throw new PlayoffError(409, 'A playoff runs now. Finish it or leave it first.');
    }
    const fresh: PlayoffSeat = { joined: false, times: [] };
    return {
      id: (playoff?.id ?? 0) + 1,
      seed: request.seed,
      preset: request.preset,
      by: seat,
      seats: { X: { ...fresh }, O: { ...fresh }, [seat]: { joined: true, times: [] } },
      startAt: null,
      ended: null,
    };
  }
  if (playoff === null || playoff.id !== request.id || playoff.ended !== null) return playoff;
  const mine = playoff.seats[seat];
  switch (request.action) {
    case 'join': {
      if (mine.joined) return playoff;
      const seats = { ...playoff.seats, [seat]: { ...mine, joined: true } };
      const startAt = seats[other(seat)].joined ? now + PLAYOFF_COUNTDOWN_MS : null;
      return { ...playoff, seats, startAt };
    }
    case 'leave':
      return { ...playoff, ended: playoff.startAt === null && !mine.joined ? 'declined' : 'left' };
    case 'hit': {
      if (playoff.startAt === null || now < playoff.startAt) throw new PlayoffError(409, 'The playoff has not started.');
      // A repeat of a hit that the server has already is fine: the page sends again after a lost answer.
      if (request.index < mine.times.length) return playoff;
      if (request.index !== mine.times.length) throw new PlayoffError(409, 'A hit came out of order.');
      const seats = { ...playoff.seats, [seat]: { ...mine, times: [...mine.times, request.ms] } };
      const done = seats.X.times.length === PLAYOFF_TARGETS && seats.O.times.length === PLAYOFF_TARGETS;
      return { ...playoff, seats, ended: done ? 'done' : null };
    }
  }
}

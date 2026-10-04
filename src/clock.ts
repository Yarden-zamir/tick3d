// Time limits, like a chess clock. The page and the server both use this file.
import { type Game, type Player, other } from './game.ts';

// Seconds, or null for no limit of that kind. With both limits, the first one to run out decides.
export type TimeControl = { perMove: number | null; perGame: number | null };

export const NO_LIMIT: TimeControl = { perMove: null, perGame: null };

// The database CHECK constraints in server/store.ts use the same ranges.
export const LIMIT_RANGE = {
  perMove: { min: 3, max: 600 },
  perGame: { min: 30, max: 7200 },
} as const;

export const hasLimit = (control: TimeControl) => control.perMove !== null || control.perGame !== null;

export const sameClock = (a: TimeControl, b: TimeControl) => a.perMove === b.perMove && a.perGame === b.perGame;

function parseLimit(value: unknown, kind: keyof typeof LIMIT_RANGE): number | null | undefined {
  if (value === null) return null;
  const { min, max } = LIMIT_RANGE[kind];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

// Accepts { perMove, perGame } with each value null or whole seconds inside LIMIT_RANGE.
export function parseClock(value: unknown): TimeControl | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const perMove = parseLimit(fields.perMove, 'perMove');
  const perGame = parseLimit(fields.perGame, 'perGame');
  return perMove === undefined || perGame === undefined ? undefined : { perMove, perGame };
}

// "30 s", "1 min 30 s", "5 min".
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export function describeClock(control: TimeControl): string {
  const parts = [
    control.perGame === null ? undefined : `${formatDuration(control.perGame)} per player`,
    control.perMove === null ? undefined : `${formatDuration(control.perMove)} per move`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? 'No time limit' : parts.join(' + ');
}

// "4:05" for a clock face. Rounds up, so a clock shows 0:00 only when the time is over.
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Milliseconds a player has: on the game limit, on the move limit, and the smaller one that decides.
export type PlayerClock = { left: number; game: number | null; move: number | null };

// The clock of each player at `now`, or null when the game has no limit.
// The first move of each player is untimed, so the clocks start once both players moved once.
// This also keeps the clock still while an online game waits for the second player.
export function remaining(game: Game, now: number): Record<Player, PlayerClock> | null {
  const { perMove, perGame } = game.clock;
  if (perMove === null && perGame === null) return null;
  const bank: Record<Player, number | null> = {
    X: perGame === null ? null : perGame * 1000,
    O: perGame === null ? null : perGame * 1000,
  };
  const mover = (i: number): Player => (i % 2 === 0 ? game.first : other(game.first));
  for (let i = 2; i < game.moves.length; i++) {
    const spent = (game.times[i] ?? 0) - (game.times[i - 1] ?? 0);
    const before = bank[mover(i)];
    if (before !== null) bank[mover(i)] = before - spent;
  }
  const live = game.status.kind === 'playing' && game.moves.length >= 2;
  const running = live ? now - (game.times.at(-1) ?? now) : 0;
  const clockOf = (player: Player): PlayerClock => {
    const used = live && game.turn === player ? running : 0;
    const bankLeft = bank[player];
    const gameLeft = bankLeft === null ? null : bankLeft - used;
    const moveLeft = perMove === null ? null : perMove * 1000 - used;
    const left = Math.min(gameLeft ?? Infinity, moveLeft ?? Infinity);
    const timedOut = game.status.kind === 'timeout' && game.status.winner !== player;
    return { left: timedOut ? 0 : left, game: gameLeft, move: moveLeft };
  };
  return { X: clockOf('X'), O: clockOf('O') };
}

export function isFlagged(game: Game, now: number): boolean {
  const clocks = remaining(game, now);
  return game.status.kind === 'playing' && clocks !== null && clocks[game.turn].left <= 0;
}

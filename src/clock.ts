// Time controls, like a chess clock. The page and the server both use this file.
import { type Game, type Player, other } from './game.ts';

export type TimeControl = { kind: 'off' } | { kind: 'move' | 'game'; seconds: number };

export const CLOCK_PRESETS: readonly TimeControl[] = [
  { kind: 'off' },
  { kind: 'move', seconds: 10 },
  { kind: 'move', seconds: 30 },
  { kind: 'move', seconds: 60 },
  { kind: 'game', seconds: 60 },
  { kind: 'game', seconds: 180 },
  { kind: 'game', seconds: 300 },
  { kind: 'game', seconds: 600 },
];

// A stable text key, for <select> values and storage: "off", "move:30", "game:300".
export function clockKey(control: TimeControl): string {
  return control.kind === 'off' ? 'off' : `${control.kind}:${control.seconds}`;
}

// Only the presets are valid, so a stored or sent value can never be an odd time control.
export function parseClock(value: unknown): TimeControl | undefined {
  if (typeof value === 'string') return CLOCK_PRESETS.find((preset) => clockKey(preset) === value);
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, seconds } = value as Record<string, unknown>;
  return CLOCK_PRESETS.find(
    (preset) => preset.kind === kind && (preset.kind === 'off' || preset.seconds === seconds),
  );
}

export function describeClock(control: TimeControl): string {
  if (control.kind === 'off') return 'No time limit';
  const amount = control.seconds < 60 ? `${control.seconds} s` : `${control.seconds / 60} min`;
  return control.kind === 'move' ? `${amount} per move` : `${amount} per player`;
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Milliseconds left for each player at `now`, or null without a time limit.
// The first move of each player is untimed, so the clock starts once both players moved once.
// This also keeps the clock still while an online game waits for the second player.
export function remaining(control: TimeControl, game: Game, now: number): Record<Player, number> | null {
  if (control.kind === 'off') return null;
  const limit = control.seconds * 1000;
  const left: Record<Player, number> = { X: limit, O: limit };
  const mover = (i: number): Player => (i % 2 === 0 ? game.first : other(game.first));
  const spent = (i: number) => (game.times[i] ?? 0) - (game.times[i - 1] ?? 0);
  // Per move, each move starts with the full limit. Per game, time spent adds up.
  if (control.kind === 'game') {
    for (let i = 2; i < game.moves.length; i++) left[mover(i)] -= spent(i);
  }
  const last = game.times.at(-1);
  if (game.status.kind === 'playing' && game.moves.length >= 2 && last !== undefined) {
    left[game.turn] -= now - last;
  }
  if (game.status.kind === 'timeout') left[other(game.status.winner)] = 0;
  return left;
}

export function isFlagged(control: TimeControl, game: Game, now: number): boolean {
  const left = remaining(control, game, now);
  return game.status.kind === 'playing' && left !== null && left[game.turn] <= 0;
}

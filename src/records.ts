// Survival records against the computer: the most moves that a game lasted before the computer won.
// Each match setup keeps its own record, because a time limit or a hidden board changes how long a player lasts.
import type { Difficulty } from './ai.ts';
import type { TimeControl } from './clock.ts';

export type RecordSetup = {
  difficulty: Difficulty;
  clock: TimeControl;
  hideBoard: boolean;
  hideHistory: boolean;
  // A computer with changed advanced settings plays another game, so it keeps separate records.
  tuned: boolean;
};
export type Records = Readonly<Record<string, number>>;
// A record that a game just broke. The first game of a setup sets a record without news.
export type RecordNews = { moves: number; previous: number };

export function recordKey(setup: RecordSetup): string {
  const { difficulty, clock, hideBoard, hideHistory, tuned } = setup;
  const parts = [difficulty, `game:${clock.perGame ?? 'none'}`, `move:${clock.perMove ?? 'none'}`, `board:${hideBoard}`, `history:${hideHistory}`];
  // Only a tuned setup adds a part, so the keys of the default computer stay as they were.
  return [...parts, ...(tuned ? ['tuned'] : [])].join('|');
}

// Stored records come from an older visit or a hand edit, so keep only whole positive move counts.
export function parseRecords(value: unknown): Records {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] > 0),
  );
}

// Adds a game that the computer won after `moves` moves.
export function addLoss(records: Records, setup: RecordSetup, moves: number): { records: Records; news?: RecordNews } {
  if (!Number.isInteger(moves) || moves <= 0) throw new RangeError(`a lost game has a positive move count, not ${moves}`);
  const key = recordKey(setup);
  const previous = records[key];
  if (previous !== undefined && moves <= previous) return { records };
  const next = { ...records, [key]: moves };
  return previous === undefined ? { records: next } : { records: next, news: { moves, previous } };
}

// The higher record of each setup, for example this device's records and the account's records on the server.
export function mergeRecords(a: Records, b: Records): Records {
  const merged: Record<string, number> = { ...a };
  for (const [key, moves] of Object.entries(b)) merged[key] = Math.max(merged[key] ?? 0, moves);
  return merged;
}

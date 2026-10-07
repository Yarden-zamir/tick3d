import { keysOf } from './guards.ts';
import type { Difficulty } from './ai.ts';

// Every number that shapes the computer player. The defaults are the tested levels, and the
// advanced settings change them. Easy and medium tire during a long game, like a human player
// under more and more load: each value moves from `fresh` to `tired` between two move counts.

// What a level notices and how freely it chooses. The chances run from 0 to 1.
export type Feel = {
  // The chance to block a winning cell of the opponent.
  block: number;
  // The chance to see its own double threat, and the opponent's.
  fork: number;
  forkBlock: number;
  // A higher temperature gives more random, more human choices.
  temperature: number;
};

export type StyleTuning = {
  fresh: Feel;
  tired: Feel;
  // The level plays fresh until move `tireFrom` and fully tired from move `tireTo`.
  tireFrom: number;
  tireTo: number;
  // How much the level values blocking the opponent's lines, against building its own.
  defense: number;
  // Only the best few cells are candidates for the weighted choice.
  candidates: number;
};

export type HardTuning = {
  budgetMs: number;
  // The search looks at the best few moves per position only.
  branching: number;
  // The forced-win search follows at most this many threats in a row.
  threatDepth: number;
  // Moves within this margin of the best search score count as equal, so the level varies its play.
  nearBest: number;
};

export type Tuning = { easy: StyleTuning; medium: StyleTuning; hard: HardTuning; strongCellBonus: number };
export type StyledLevel = 'easy' | 'medium';

export const DEFAULT_TUNING: Tuning = {
  easy: {
    fresh: { block: 0.6, fork: 0.2, forkBlock: 0, temperature: 14 },
    tired: { block: 0.25, fork: 0.1, forkBlock: 0, temperature: 20 },
    tireFrom: 6,
    tireTo: 41,
    defense: 0.15,
    candidates: 12,
  },
  medium: {
    fresh: { block: 1, fork: 0.15, forkBlock: 0.1, temperature: 10 },
    tired: { block: 0.85, fork: 0.1, forkBlock: 0.07, temperature: 12 },
    tireFrom: 20,
    tireTo: 60,
    defense: 0.9,
    candidates: 6,
  },
  // A wider `nearBest` varies more but costs strength: 14 scored 38% against the previous hard level
  // at 600 ms. Measure again with a self-play match when the budget or the evaluation changes.
  hard: { budgetMs: 600, branching: 10, threatDepth: 8, nearBest: 1 },
  // A cell on 7 lines (the 8 corners and the 8 inner cells) is worth more than a cell on 4 lines.
  strongCellBonus: 3,
};

// How the level feels after `moves` moves of the game.
export function feelAt(style: StyleTuning, moves: number): Feel {
  const span = style.tireTo - style.tireFrom;
  const progress = span <= 0 ? (moves >= style.tireTo ? 1 : 0) : Math.min(1, Math.max(0, (moves - style.tireFrom) / span));
  const mix = (key: keyof Feel) => style.fresh[key] + (style.tired[key] - style.fresh[key]) * progress;
  return { block: mix('block'), fork: mix('fork'), forkBlock: mix('forkBlock'), temperature: mix('temperature') };
}

// One number of the advanced settings, with its allowed range.
export type TuningField = {
  group: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get(tuning: Tuning): number;
  set(tuning: Tuning, value: number): Tuning;
};

const FEEL_LABELS: Record<keyof Feel, [label: string, min: number, max: number, step: number]> = {
  block: ['Block chance', 0, 1, 0.01],
  fork: ['Sees own double threat', 0, 1, 0.01],
  forkBlock: ["Sees opponent's double threat", 0, 1, 0.01],
  temperature: ['Randomness', 1, 60, 1],
};

function styleFields(level: StyledLevel): TuningField[] {
  const group = level === 'easy' ? 'Easy' : 'Medium';
  const setStyle = (tuning: Tuning, change: Partial<StyleTuning>): Tuning => ({ ...tuning, [level]: { ...tuning[level], ...change } });
  const feelFields = (['fresh', 'tired'] as const).flatMap((state) =>
    keysOf(FEEL_LABELS).map((key): TuningField => {
      const [label, min, max, step] = FEEL_LABELS[key];
      return {
        group,
        label: `${label}, ${state}`,
        min,
        max,
        step,
        get: (tuning) => tuning[level][state][key],
        set: (tuning, value) => setStyle(tuning, { [state]: { ...tuning[level][state], [key]: value } }),
      };
    }),
  );
  const plain = (key: 'tireFrom' | 'tireTo' | 'defense' | 'candidates', label: string, min: number, max: number, step: number): TuningField => ({
    group,
    label,
    min,
    max,
    step,
    get: (tuning) => tuning[level][key],
    set: (tuning, value) => setStyle(tuning, { [key]: value }),
  });
  return [
    ...feelFields,
    plain('tireFrom', 'Starts to tire at move', 0, 64, 1),
    plain('tireTo', 'Fully tired at move', 0, 64, 1),
    plain('defense', 'Defense weight', 0, 2, 0.01),
    plain('candidates', 'Cells it considers', 1, 64, 1),
  ];
}

const hardField = (key: keyof HardTuning, label: string, min: number, max: number, step: number): TuningField => ({
  group: 'Hard',
  label,
  min,
  max,
  step,
  get: (tuning) => tuning.hard[key],
  set: (tuning, value) => ({ ...tuning, hard: { ...tuning.hard, [key]: value } }),
});

export const TUNING_FIELDS: readonly TuningField[] = [
  ...styleFields('easy'),
  ...styleFields('medium'),
  // The search runs in a Web Worker, so a long search does not freeze the page. A timed game still
  // counts the thinking time. The shortest move limit is 3 s, and the computer waits 450 ms before
  // it searches. A cap of one second keeps a wide margin for a slow device and for the deadline
  // checks inside the search. A longer cap needs a budget that follows the clock, so revisit this
  // cap when the hard level needs more time.
  hardField('budgetMs', 'Thinking time (ms)', 50, 1000, 50),
  hardField('branching', 'Moves searched per position', 2, 30, 1),
  hardField('threatDepth', 'Threats in a row it looks for', 1, 12, 1),
  hardField('nearBest', 'Equal-move margin', 0, 100, 1),
  {
    group: 'All levels',
    label: 'Strong cell bonus',
    min: 0,
    max: 20,
    step: 1,
    get: (tuning) => tuning.strongCellBonus,
    set: (tuning, value) => ({ ...tuning, strongCellBonus: value }),
  },
];

// A value inside the field's range, or undefined. Whole-number fields round to a whole number.
// The step only sets the size of the input arrows, so a stored value never moves to another step.
export function fieldValue(field: TuningField, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) return undefined;
  return Number.isInteger(field.step) ? Math.round(value) : value;
}

// Stored settings come from an older visit or a hand edit, so check every number and keep the default for a bad one.
export function parseTuning(value: unknown): Tuning {
  if (typeof value !== 'object' || value === null) return DEFAULT_TUNING;
  let tuning = DEFAULT_TUNING;
  for (const field of TUNING_FIELDS) {
    let stored: unknown;
    try {
      stored = field.get(value as Tuning);
    } catch {
      continue; // a missing group in the stored object
    }
    const checked = fieldValue(field, stored);
    if (checked !== undefined) tuning = field.set(tuning, checked);
  }
  return tuning;
}

export const isDefaultTuning = (tuning: Tuning) => TUNING_FIELDS.every((field) => field.get(tuning) === field.get(DEFAULT_TUNING));

const LEVEL_GROUPS: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// True when a game at `level` plays with changed settings: that level's own fields, or a field of
// "All levels". A changed hard level does not make an easy game tuned.
export function isTunedFor(tuning: Tuning, level: Difficulty): boolean {
  return TUNING_FIELDS.some(
    (field) => (field.group === LEVEL_GROUPS[level] || field.group === 'All levels') && field.get(tuning) !== field.get(DEFAULT_TUNING),
  );
}

// True when every field holds a number inside its range. Unlike parseTuning, this never falls back
// to a default, so an upload with a broken value is refused instead of quietly fixed.
export function isTuning(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return TUNING_FIELDS.every((field) => {
    let stored: unknown;
    try {
      stored = field.get(value as Tuning);
    } catch {
      return false;
    }
    return typeof stored === 'number' && fieldValue(field, stored) === stored;
  });
}

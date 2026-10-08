// The rules of the practice modes of the Voice room (/sound-input), shared by the page and the server: the presets,
// the seeded targets, the heat (how near the pitch is), the scores, and the check of a finished run.
// The steps and cells come from src/voice/mapping.ts: 64 steps of the range, one for each cell.
import { CELL_COUNT, toCoords } from '../game.ts';
import { isRecord } from '../guards.ts';

export const PRACTICE_MODES = ['targets', 'echo'] as const;
export type PracticeMode = (typeof PRACTICE_MODES)[number];

export const PRESET_IDS = ['easy', 'normal', 'hard'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

// `maxJump` is the largest distance in steps from one target to the next: the spread of the targets.
// `holdMs` is how long the light must sit on the target. `sticky` false turns the stickiness off.
export type Preset = { name: string; maxJump: number; holdMs: number; sticky: boolean };

export const PRESETS: Record<PresetId, Preset> = {
  easy: { name: 'Easy', maxJump: 8, holdMs: 500, sticky: true },
  normal: { name: 'Normal', maxJump: 24, holdMs: 600, sticky: true },
  hard: { name: 'Hard', maxJump: CELL_COUNT - 1, holdMs: 800, sticky: false },
};

// Targets in one run of each mode.
export const ROUNDS: Record<PracticeMode, number> = { targets: 10, echo: 8 };
// A target or an echo round that takes longer than this counts as this long. A run then always ends.
export const MAX_ROUND_MS = 120_000;
// The nearest target is this many steps from the one before, so each target asks for a move.
const MIN_JUMP = 2;
// An echo round gives 100 points for the right cell, and 25 fewer for each step off in layer, row or column.
export const ECHO_POINTS = 100;
const ECHO_STEP_COST = 25;

// A small, fast random source from a 32-bit seed (mulberry32). The same seed gives the same targets on
// every device, so the two players of a playoff get the same run.
export function seededRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new RangeError(`not a 32-bit seed: ${seed}`);
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export const newSeed = (): number => Math.floor(Math.random() * 2 ** 32);

// The target steps of a run: each one MIN_JUMP to maxJump steps from the one before.
export function targetSteps(seed: number, preset: PresetId, count: number): number[] {
  const random = seededRandom(seed);
  const { maxJump } = PRESETS[preset];
  const pick = (from: number, to: number) => from + Math.floor(random() * (to - from + 1));
  const steps = [pick(0, CELL_COUNT - 1)];
  while (steps.length < count) {
    const last = steps.at(-1) ?? 0;
    const options: number[] = [];
    for (let step = Math.max(0, last - maxJump); step <= Math.min(CELL_COUNT - 1, last + maxJump); step++) {
      if (Math.abs(step - last) >= MIN_JUMP) options.push(step);
    }
    const next = options[pick(0, options.length - 1)];
    if (next === undefined) throw new Error(`no target near step ${last}`);
    steps.push(next);
  }
  return steps;
}

export type Heat = { word: 'On it' | 'Hot' | 'Warm' | 'Cool' | 'Cold'; direction: 'up' | 'down' | 'here'; share: number };

// How near the pitch at `position` (0 to 64) is to the target step. `share` is 1 on the target and 0 far away.
export function heatOf(position: number, target: number): Heat {
  const center = target + 0.5;
  const distance = Math.abs(position - center);
  const direction = distance < 0.5 ? 'here' : position < center ? 'up' : 'down';
  const share = Math.max(0, 1 - distance / 16);
  const word = distance < 0.5 ? 'On it' : distance < 2 ? 'Hot' : distance < 6 ? 'Warm' : distance < 16 ? 'Cool' : 'Cold';
  return { word, direction, share };
}

export function echoPoints(target: number, answer: number): number {
  const a = toCoords(target);
  const b = toCoords(answer);
  const off = Math.abs(a.layer - b.layer) + Math.abs(a.row - b.row) + Math.abs(a.column - b.column);
  return Math.max(0, ECHO_POINTS - ECHO_STEP_COST * off);
}

export type Summary = { totalMs: number; averageMs: number; bestMs: number; worstMs: number };

export function summarize(times: readonly number[]): Summary {
  if (times.length === 0) throw new RangeError('a summary needs at least one time');
  const totalMs = times.reduce((sum, time) => sum + time, 0);
  return { totalMs, averageMs: totalMs / times.length, bestMs: Math.min(...times), worstMs: Math.max(...times) };
}

// A finished run, as the page sends it to POST /api/practice/runs. `id` lets a page send again after a lost
// answer. `score` is the echo points, or the number of targets in a target run.
export type PracticeRun = { id: string; mode: PracticeMode; preset: PresetId; roundMs: number[]; score: number };

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((option) => option === value);

// Checks a run from a page. Returns undefined for anything that a real run of the page cannot be.
export function parsePracticeRun(value: unknown): PracticeRun | undefined {
  if (!isRecord(value)) return undefined;
  const mode = oneOf(PRACTICE_MODES, value.mode);
  const preset = oneOf(PRESET_IDS, value.preset);
  const { id, roundMs, score } = value;
  if (mode === undefined || preset === undefined) return undefined;
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return undefined;
  if (!Array.isArray(roundMs) || roundMs.length !== ROUNDS[mode]) return undefined;
  if (!roundMs.every((ms): ms is number => Number.isInteger(ms) && ms >= 0 && ms <= MAX_ROUND_MS)) return undefined;
  const maxScore = mode === 'echo' ? ECHO_POINTS * ROUNDS.echo : ROUNDS.targets;
  if (!Number.isInteger(score) || typeof score !== 'number' || score < 0 || score > maxScore) return undefined;
  if (mode === 'targets' && score !== ROUNDS.targets) return undefined;
  return { id, mode, preset, roundMs: [...roundMs], score };
}

// True when run `a` beats run `b`: a target run by its total time, an echo run by its points, then its time.
export function beats(mode: PracticeMode, a: { totalMs: number; score: number }, b: { totalMs: number; score: number }): boolean {
  if (mode === 'echo' && a.score !== b.score) return a.score > b.score;
  return a.totalMs < b.totalMs;
}

export const presetKey = (mode: PracticeMode, preset: PresetId) => `${mode}:${preset}` as const;
type PresetKey = ReturnType<typeof presetKey>;
type Best = { totalMs: number; score: number; at: number };

// One place of a leaderboard. `player` is a GitHub login or a generated name.
export type PracticeLeader = { mode: PracticeMode; preset: PresetId; rank: number; player: string; totalMs: number; score: number };
// GET /api/practice/best: the best 10 people of one mode and preset, and the caller's own best.
export type PracticeBoard = { mode: PracticeMode; preset: PresetId; top: PracticeLeader[]; you: { totalMs: number; score: number } | null };
// The practice part of the stats page.
export type PracticeStats = {
  runs: { mode: PracticeMode; preset: PresetId; runs: number; players: number; avgRoundMs: number | null }[];
  best: PracticeLeader[];
};

// The page reads the board only to show it, so the check stays at the shape of each place.
export function parsePracticeBoard(value: unknown): PracticeBoard {
  if (!isRecord(value) || !Array.isArray(value.top)) throw new Error('invalid answer from /api/practice/best');
  const mode = oneOf(PRACTICE_MODES, value.mode);
  const preset = oneOf(PRESET_IDS, value.preset);
  const you = value.you;
  if (mode === undefined || preset === undefined) throw new Error('invalid answer from /api/practice/best');
  const top = value.top.map((entry): PracticeLeader => {
    if (!isRecord(entry) || typeof entry.player !== 'string' || typeof entry.rank !== 'number' || typeof entry.totalMs !== 'number' || typeof entry.score !== 'number') {
      throw new Error('invalid place in /api/practice/best');
    }
    return { mode, preset, rank: entry.rank, player: entry.player, totalMs: entry.totalMs, score: entry.score };
  });
  if (you !== null && (!isRecord(you) || typeof you.totalMs !== 'number' || typeof you.score !== 'number')) throw new Error('invalid answer from /api/practice/best');
  return { mode, preset, top, you: you === null ? null : { totalMs: you.totalMs as number, score: you.score as number } };
}

// The query of GET /api/practice/best. undefined for an unknown mode or preset.
export function parseBoardQuery(mode: string | null, preset: string | null): { mode: PracticeMode; preset: PresetId } | undefined {
  const knownMode = oneOf(PRACTICE_MODES, mode);
  const knownPreset = oneOf(PRESET_IDS, preset);
  return knownMode === undefined || knownPreset === undefined ? undefined : { mode: knownMode, preset: knownPreset };
}

// The bests of this device, by mode and preset (presetKey). The device keeps them in localStorage, so a
// stored value can come from an older visit or a hand edit: a bad entry is left out.
export type Bests = Partial<Record<PresetKey, Best>>;
export const BESTS_VERSION = 1;

export function parseBests(value: unknown): Bests {
  if (!isRecord(value) || value.version !== BESTS_VERSION || !isRecord(value.best)) return {};
  const bests: Bests = {};
  for (const mode of PRACTICE_MODES) {
    for (const preset of PRESET_IDS) {
      const key = presetKey(mode, preset);
      const entry = value.best[key];
      if (!isRecord(entry)) continue;
      const { totalMs, score, at } = entry;
      if (typeof totalMs === 'number' && totalMs >= 0 && typeof score === 'number' && score >= 0 && typeof at === 'number') bests[key] = { totalMs, score, at };
    }
  }
  return bests;
}

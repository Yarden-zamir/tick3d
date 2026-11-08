// Cases of the achievement rules for the Rust server (rust/server/src/achievements.rs): random players with games and
// invites, and the progress that src/achievements.ts gives them. contract/contract.test.ts writes them to
// rust/server/achievement-cases.json, so the Rust rules cannot drift from these rules.
// The seed is fixed, so the same rules give the same file.
// Limit: no case wins with the 64th move (last-move): a fixture of such a game is hard to build. Random outcomes also
// rarely make a run of 5 wins against the computer or 20 different people, so those cases check the count only.
// Revisit this when one of these rules changes.
import { type AchievementGame, type Invites, ACHIEVEMENTS, achievementProgress } from '../src/achievements.ts';
import type { TimeControl } from '../src/clock.ts';
import { toEpochMs as ms } from '../src/epoch.ts';
import type { GameId, SessionMode } from '../src/protocol.ts';

// Raise it when a rule in src/achievements.ts changes: every row of achievement_players then fills again.
// A new or removed achievement changes the signatures by itself.
const ACHIEVEMENT_RULES_VERSION = 5;

// The game fixtures of src/achievements.test.ts.
const X_ROW = [0, 16, 1, 17, 2, 18, 3];
const X_SPACE = [0, 1, 21, 2, 42, 3, 63];
const O_ROW = [4, 0, 5, 1, 6, 2, 32, 3];
const X_FORK = [1, 63, 2, 21, 16, 42, 32, 54, 0, 3, 48];
const DRAW_BOARD = 'XXOXOOXOXOXXXXOXOOXOOXOXXOXXXOOXOOXOXXXOXOOXOXOOOOXXOXOOOXXOXOXO';
const cellsOf = (mark: string) => DRAW_BOARD.split('').flatMap((value, cell) => (value === mark ? [cell] : []));
const DRAW = cellsOf('X').flatMap((x, i) => [x, cellsOf('O')[i] ?? -1]);
// A longer win of X along a row, with O spread over other floors.
const X_SLOW = [0, 21, 1, 42, 2, 63, 5, 22, 3];
const FINISHED = [X_ROW, X_SPACE, O_ROW, X_FORK, DRAW, X_SLOW];
const CLOCKS: TimeControl[] = [
  { perMove: null, perGame: null },
  { perMove: 30, perGame: null },
  { perMove: 10, perGame: null },
  { perMove: 5, perGame: null },
  { perMove: null, perGame: 120 },
  { perMove: null, perGame: 60 },
  { perMove: null, perGame: 30 },
  { perMove: null, perGame: 5 },
];
const MODES: SessionMode[] = ['computer', 'computer', 'computer', 'online', 'online', 'nearby', 'friend'];
// Enough people for the goals about 5 and 20 different people.
const OPPONENTS = Array.from({ length: 24 }, (_, i) => `person-${i}`);

type AchievementCase = { games: AchievementGame[]; invites: Invites; progress: ReturnType<typeof achievementProgress> };

// A small fixed generator (mulberry32), so the file only changes with the rules.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// `rulesVersion` goes into the signatures of achievement_players, which both servers write.
export function achievementCases(count = 90): { rulesVersion: number; rules: { id: string; goal: number }[]; cases: AchievementCase[] } {
  const next = random(265);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  };
  const chance = (p: number) => next() < p;
  let gameNumber = 0;
  const cases: AchievementCase[] = [];
  for (let player = 0; player < count; player++) {
    let finishedAt = 1_000_000;
    const games: AchievementGame[] = [];
    // The first player plays enough games for the goal of 100. A favorite mode makes runs for the streak goals.
    const total = player === 0 ? 105 : 1 + Math.floor(next() * 30);
    const favorite = pick(MODES);
    for (let i = 0; i < total; i++) {
      const mode = chance(0.7) ? favorite : pick(MODES);
      // A game that ended on time: a part of a win, before its last move.
      const timedOut = chance(0.15);
      const full = pick(FINISHED.filter((moves) => moves !== DRAW || !timedOut));
      const moves = timedOut ? full.slice(0, 1 + Math.floor(next() * (full.length - 2))) : full;
      const gaps = moves.map(() => (chance(0.3) ? 200 + Math.floor(next() * 900) : 1000 + Math.floor(next() * 12_000)));
      finishedAt += 1 + gaps.reduce((sum, gap) => sum + gap, 0);
      let at = finishedAt - gaps.reduce((sum, gap) => sum + gap, 0);
      const times = gaps.map((gap) => ms((at += gap)));
      const person = mode === 'online' || mode === 'nearby';
      const opponent = person && chance(0.85) ? pick(OPPONENTS) : null;
      const inviteAt = () => (chance(0.25) ? ms(finishedAt - Math.floor(next() * 200_000)) : null);
      const board = Math.floor(next() * 4);
      const keypad = Math.floor(next() * 4);
      games.push({
        id: chance(0.1) ? null : (`g${String(gameNumber++).padStart(7, '0')}` as GameId),
        mode,
        game: { moves, times, clock: pick(CLOCKS), timedOut },
        you: mode === 'friend' ? null : pick(['X', 'O'] as const),
        difficulty: mode === 'computer' ? pick(['easy', 'medium', 'hard'] as const) : null,
        options: { hideBoard: chance(0.3), hideHistory: chance(0.3), hideCoordinates: chance(0.3) },
        tuned: mode === 'computer' && chance(0.15),
        finishedAt: ms(finishedAt),
        opponent,
        input: mode === 'computer' && chance(0.6) ? { board: chance(0.5) ? 0 : board, keypad, voice: chance(0.5) ? keypad : Math.floor(next() * (keypad + 1)) } : null,
        invitedOpponentAt: opponent === null ? null : inviteAt(),
        invitedByOpponentAt: opponent === null ? null : inviteAt(),
      });
    }
    const times = (most: number) => Array.from({ length: Math.floor(next() * most) }, () => ms(Math.floor(next() * 2_000_000)));
    const invites = chance(0.4) ? { direct: times(30), second: times(4) } : { direct: [], second: [] };
    // Out of order on purpose: the rules sort the games.
    const shuffled = [...games];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as AchievementGame, shuffled[i] as AchievementGame];
    }
    cases.push({ games: shuffled, invites, progress: achievementProgress(shuffled, invites) });
  }
  return { rulesVersion: ACHIEVEMENT_RULES_VERSION, rules: ACHIEVEMENTS.map(({ id, goal }) => ({ id, goal })), cases };
}

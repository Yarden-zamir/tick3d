import { describe, expect, it } from 'vitest';
import { type AchievementGame, type AchievementId, type AchievementProgress, ACHIEVEMENTS, achievementProgress, parseAchievements } from './achievements.ts';
import { NO_LIMIT } from './clock.ts';
import { toEpochMs as ms } from './epoch.ts';
import { type GameId, newGameId } from './protocol.ts';

// X wins along a row in 7 moves.
const X_ROW = [0, 16, 1, 17, 2, 18, 3];
// X wins along the space diagonal 0-21-42-63 in 7 moves.
const X_SPACE = [0, 1, 21, 2, 42, 3, 63];
// O wins along a row in 8 moves.
const O_ROW = [4, 0, 5, 1, 6, 2, 32, 3];
// A full cube with no line (see src/game.test.ts), X marks and O marks in turn.
const DRAW_BOARD = 'XXOXOOXOXOXXXXOXOOXOOXOXXOXXXOOXOOXOXXXOXOOXOXOOOOXXOXOOOXXOXOXO';
const cellsOf = (mark: string) => [...DRAW_BOARD].flatMap((value, cell) => (value === mark ? [cell] : []));
const DRAW = cellsOf('X').flatMap((x, i) => [x, cellsOf('O')[i] ?? -1]);

let clock = 1000;
// A computer game on Hard by default, where the player holds X. Each game finishes after the one before.
function game(moves: number[], extra: Partial<AchievementGame> = {}): AchievementGame {
  clock += 1000;
  return {
    id: newGameId(),
    mode: 'computer',
    game: { moves, times: moves.map((_, i) => ms(clock - moves.length + i)), clock: NO_LIMIT, timedOut: false },
    you: 'X',
    difficulty: 'hard',
    options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
    tuned: false,
    finishedAt: ms(clock),
    ...extra,
  };
}

const unlocked = (progress: readonly AchievementProgress[]): AchievementId[] => progress.filter((p) => p.unlockedAt !== null).map((p) => p.id);
const progressOf = (progress: readonly AchievementProgress[], id: AchievementId) => progress.find((p) => p.id === id);

describe('achievements', () => {
  it('unlocks nothing without games, with every achievement listed once', () => {
    const progress = achievementProgress([]);
    expect(progress.map((p) => p.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    expect(unlocked(progress)).toEqual([]);
  });

  it('names the game that unlocked an achievement', () => {
    const first = game(X_ROW);
    const progress = achievementProgress([game(O_ROW), first, game(X_ROW)]);
    expect(progressOf(progress, 'first-win')).toEqual({ id: 'first-win', count: 1, unlockedAt: first.finishedAt, unlockedBy: first.id });
  });

  it('counts a computer level only for an untuned win at that level', () => {
    expect(unlocked(achievementProgress([game(X_ROW, { difficulty: 'easy' })]))).toContain('beat-easy');
    expect(unlocked(achievementProgress([game(X_ROW, { difficulty: 'easy', tuned: true })]))).not.toContain('beat-easy');
    expect(unlocked(achievementProgress([game(X_ROW, { you: 'O' })]))).not.toContain('beat-hard');
  });

  it('knows the fastest win and the line kind', () => {
    const fast = unlocked(achievementProgress([game(X_ROW)]));
    expect(fast).toContain('fastest-win');
    expect(fast).not.toContain('space-diagonal');
    expect(unlocked(achievementProgress([game(X_SPACE)]))).toContain('space-diagonal');
    expect(unlocked(achievementProgress([game(O_ROW, { you: 'O' })]))).not.toContain('fastest-win');
  });

  it('counts a win on time, but not as a line', () => {
    // X moved last, so O ran out of time: X wins.
    const moves = X_ROW.slice(0, 5);
    const timeout = game(moves, { game: { moves, times: moves.map((_, i) => ms(i)), clock: { perMove: 10, perGame: null }, timedOut: true } });
    const progress = unlocked(achievementProgress([timeout]));
    expect(progress).toEqual(expect.arrayContaining(['first-win', 'timed-win']));
    expect(progress).not.toContain('fastest-win');
  });

  it('reads the hide settings and the mode', () => {
    const hidden = { hideBoard: true, hideHistory: false, hideCoordinates: true };
    expect(unlocked(achievementProgress([game(X_ROW, { options: hidden })]))).toEqual(expect.arrayContaining(['board-hidden', 'coordinates-hidden']));
    expect(unlocked(achievementProgress([game(X_ROW, { mode: 'online', difficulty: null })]))).toContain('online-win');
    expect(unlocked(achievementProgress([game(X_ROW, { mode: 'nearby', difficulty: null })]))).toContain('nearby-win');
  });

  it('counts a draw and every game, also a friend game, but a friend game wins nothing', () => {
    const friend = { mode: 'friend', you: null, difficulty: null } as const;
    const progress = achievementProgress([game(DRAW, friend), game(X_ROW, friend)]);
    expect(unlocked(progress)).toEqual(['full-cube']);
    expect(progressOf(progress, 'games-10')?.count).toBe(2);
  });

  it('needs wins in a row for a streak, and a friend game does not break it', () => {
    const friend = { mode: 'friend', you: null, difficulty: null } as const;
    // game() gives each game a later finish time, so the order of the calls is the order of play.
    const twoThenLoss = [game(X_ROW), game(X_ROW), game(O_ROW), game(X_ROW)];
    expect(progressOf(achievementProgress(twoThenLoss), 'streak-3')).toMatchObject({ count: 2, unlockedAt: null });
    const games = [...twoThenLoss, game(O_ROW, friend), game(X_ROW), game(X_ROW)];
    const third = games.at(-1);
    const progress = achievementProgress(games);
    expect(progressOf(progress, 'streak-3')).toMatchObject({ count: 3, unlockedBy: third?.id });
    expect(progressOf(progress, 'streak-5')?.count).toBe(3);
  });

  it('orders the games by their finish time', () => {
    const late = game(X_ROW);
    const early = { ...game(X_ROW), finishedAt: ms(1) };
    expect(progressOf(achievementProgress([late, early]), 'first-win')?.unlockedBy).toBe(early.id);
  });

  it('stops a count at the goal', () => {
    const games = Array.from({ length: 12 }, () => game(O_ROW));
    expect(progressOf(achievementProgress(games), 'games-10')?.count).toBe(10);
  });
});

describe('parseAchievements', () => {
  const answer = (progress: AchievementProgress[]) => JSON.parse(JSON.stringify({ achievements: progress })) as unknown;

  it('reads the answer of the server back', () => {
    const progress = achievementProgress([game(X_ROW), game(X_SPACE)]);
    expect(parseAchievements(answer(progress))).toEqual(progress);
  });

  it('refuses a missing achievement, a count over the goal or an unlock without the goal', () => {
    const progress = achievementProgress([game(X_ROW)]);
    expect(parseAchievements(answer(progress.slice(1)))).toBeUndefined();
    const over = progress.map((p) => (p.id === 'games-10' ? { ...p, count: 11 } : p));
    expect(parseAchievements(answer(over))).toBeUndefined();
    const early = progress.map((p) => (p.id === 'games-10' ? { ...p, unlockedAt: ms(5), unlockedBy: 'ABCDEFGH' as GameId } : p));
    expect(parseAchievements(answer(early))).toBeUndefined();
    expect(parseAchievements(null)).toBeUndefined();
  });
});

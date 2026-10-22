import { describe, expect, it } from 'vitest';
import {
  type AchievementGame,
  type AchievementId,
  type AchievementProgress,
  type AchievementRarity,
  ACHIEVEMENTS,
  achievementProgress,
  parseAchievements,
  rarityLabel,
  rarityOf,
} from './achievements.ts';
import { NO_LIMIT } from './clock.ts';
import { toEpochMs as ms } from './epoch.ts';
import { type GameId, newGameId } from './protocol.ts';

// X wins along a row in 7 moves.
const X_ROW = [0, 16, 1, 17, 2, 18, 3];
// X wins along the space diagonal 0-21-42-63 in 7 moves.
const X_SPACE = [0, 1, 21, 2, 42, 3, 63];
// O wins along a row in 8 moves.
const O_ROW = [4, 0, 5, 1, 6, 2, 32, 3];
// X wins straight down the floors (0-16-32-48) after a fork: X 0 threatens 3 and 48, and O blocks 3.
const X_FORK = [1, 63, 2, 21, 16, 42, 32, 54, 0, 3, 48];
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
    opponent: null,
    input: null,
    invitedOpponentAt: null,
    invitedByOpponentAt: null,
    ...extra,
  };
}
const friend = { mode: 'friend', you: null, difficulty: null } as const;
const online = (opponent: string) => ({ mode: 'online', difficulty: null, opponent }) as const;
const level = (difficulty: 'easy' | 'medium' | 'hard') => ({ difficulty });

const unlocked = (progress: readonly AchievementProgress[]): AchievementId[] => progress.filter((p) => p.unlockedAt !== null).map((p) => p.id);
const unlocks = (...games: AchievementGame[]) => unlocked(achievementProgress(games));
const progressOf = (progress: readonly AchievementProgress[], id: AchievementId) => progress.find((p) => p.id === id);

describe('achievements', () => {
  it('unlocks nothing without games, with every achievement listed once', () => {
    const progress = achievementProgress([]);
    expect(progress.map((p) => p.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    expect(new Set(progress.map((p) => p.id)).size).toBe(ACHIEVEMENTS.length);
    expect(unlocked(progress)).toEqual([]);
  });

  it('names the game that unlocked an achievement', () => {
    const first = game(X_ROW);
    const progress = achievementProgress([game(O_ROW), first, game(X_ROW)]);
    expect(progressOf(progress, 'first-win')).toEqual({ id: 'first-win', count: 1, unlockedAt: first.finishedAt, unlockedBy: first.id });
  });

  it('unlocks the lower steps of a ladder with a game at a higher level', () => {
    expect(unlocks(game(X_ROW, level('easy')))).toEqual(expect.arrayContaining(['beat-easy', 'fastest-easy']));
    expect(unlocks(game(X_ROW, level('easy')))).not.toContain('beat-medium');
    const hard = unlocks(game(X_ROW));
    expect(hard).toEqual(expect.arrayContaining(['beat-easy', 'beat-medium', 'beat-hard', 'fastest-easy', 'fastest-medium']));
    // The fastest win against Hard is luck, so the top step needs a person.
    expect(hard).not.toContain('fastest-person');
    // A person counts for no computer level, only for the goals about people.
    const person = unlocks(game(X_ROW, online('ana')));
    expect(person).toEqual(expect.arrayContaining(['fastest-person', 'online-win']));
    for (const id of ['beat-easy', 'beat-hard', 'fastest-easy', 'fastest-medium'] as const) expect(person).not.toContain(id);
  });

  it('gives a tuned computer and a friend game no level', () => {
    for (const extra of [{ tuned: true }, friend]) {
      const won = unlocks(game(X_ROW, extra));
      expect(won).toContain('first-win');
      for (const id of ['beat-easy', 'fastest-easy', 'online-win', 'nearby-win'] as const) expect(won).not.toContain(id);
    }
    expect(unlocks(game(X_ROW, { you: 'O' }))).not.toContain('beat-easy');
  });

  it('reads the line of the win', () => {
    expect(unlocks(game(X_SPACE, level('medium')))).toEqual(expect.arrayContaining(['space-diagonal-easy', 'space-diagonal-medium']));
    expect(unlocks(game(X_SPACE, level('medium')))).not.toContain('space-diagonal-hard');
    expect(unlocks(game(X_ROW))).not.toContain('space-diagonal-easy');
    expect(unlocks(game(X_SPACE, online('ana')))).toContain('space-diagonal-person');
    expect(unlocks(game(X_SPACE, online('ana')))).not.toContain('space-diagonal-hard');
    expect(unlocks(game(X_FORK))).toContain('elevator');
    expect(unlocks(game(X_ROW))).not.toContain('elevator');
  });

  it('knows a fork: two cells to win on, of which the opponent blocked one', () => {
    expect(unlocks(game(X_FORK, level('medium')))).toContain('fork');
    expect(unlocks(game(X_FORK, level('easy')))).not.toContain('fork');
    expect(unlocks(game(X_FORK, online('ana')))).toContain('fork');
    expect(unlocks(game(X_ROW))).not.toContain('fork');
  });

  it('climbs the timer ladder with shorter limits, but not in a friend game', () => {
    const timed = (perMove: number | null, perGame: number | null, extra: Partial<AchievementGame> = {}) => {
      const base = game(X_ROW, extra);
      return { ...base, game: { ...base.game, clock: { perMove, perGame } } };
    };
    expect(unlocks(timed(30, null))).toContain('timed-win');
    expect(unlocks(timed(30, null))).not.toContain('timed-win-short');
    expect(unlocks(timed(null, 120))).toEqual(expect.arrayContaining(['timed-win', 'timed-win-short']));
    expect(unlocks(timed(null, 120))).not.toContain('timed-win-bullet');
    expect(unlocks(timed(5, null))).toEqual(expect.arrayContaining(['timed-win', 'timed-win-short', 'timed-win-bullet']));
    expect(unlocks(timed(5, null, friend))).not.toContain('timed-win-short');
    expect(unlocks(timed(5, null, { tuned: true }))).toContain('timed-win-bullet');
  });

  it('counts a win on time, but not as a line, and as a flag fall only against a person', () => {
    // X moved last, so O ran out of time: X wins.
    const moves = X_ROW.slice(0, 5);
    const timeout = (extra: Partial<AchievementGame>) =>
      game(moves, { game: { moves, times: moves.map((_, i) => ms(i)), clock: { perMove: 10, perGame: null }, timedOut: true }, ...extra });
    const computer = unlocks(timeout({}));
    expect(computer).toEqual(expect.arrayContaining(['first-win', 'timed-win']));
    expect(computer).not.toContain('fastest-easy');
    expect(computer).not.toContain('won-on-time');
    expect(unlocks(timeout(online('ana')))).toContain('won-on-time');
  });

  it('knows a photo finish: less than a second left after the winning move', () => {
    const finish = (lastMoveMs: number) => {
      const times = X_ROW.map((_, i) => ms(i * 1000 + (i === X_ROW.length - 1 ? lastMoveMs - 1000 : 0)));
      return game(X_ROW, { game: { moves: X_ROW, times, clock: { perMove: 10, perGame: null }, timedOut: false } });
    };
    expect(unlocks(finish(9500))).toContain('photo-finish');
    expect(unlocks(finish(8000))).not.toContain('photo-finish');
  });

  it('knows a photo finish on the game clock too', () => {
    const times = [0, 0, 10_000, 10_000, 20_000, 20_000, 29_500].map(ms);
    const finish = game(X_ROW, { game: { moves: X_ROW, times, clock: { perMove: null, perGame: 30 }, timedOut: false } });
    expect(unlocks(finish)).toContain('photo-finish');
  });

  it('knows a Hard win with the board hidden and every move by voice', () => {
    const hidden = { hideBoard: true, hideHistory: false, hideCoordinates: false };
    const byVoice = (input: { board: number; keypad: number; voice: number }, extra: Partial<AchievementGame> = {}) =>
      game(X_ROW, { options: hidden, input, ...extra });
    expect(unlocks(byVoice({ board: 0, keypad: 4, voice: 4 }))).toContain('sound-only');
    expect(unlocks(byVoice({ board: 0, keypad: 4, voice: 3 }))).not.toContain('sound-only');
    expect(unlocks(byVoice({ board: 1, keypad: 3, voice: 3 }))).not.toContain('sound-only');
    expect(unlocks(byVoice({ board: 0, keypad: 4, voice: 4 }, level('medium')))).not.toContain('sound-only');
    expect(unlocks(game(X_ROW, { options: hidden }))).not.toContain('sound-only');
  });

  it('counts a win as O, who moves second', () => {
    expect(unlocks(game(O_ROW, { you: 'O', ...level('medium') }))).toContain('o-win-medium');
    expect(unlocks(game(O_ROW, { you: 'O', ...level('medium') }))).not.toContain('o-win-hard');
    expect(unlocks(game(O_ROW, { you: 'O', ...level('easy') }))).not.toContain('o-win-medium');
    expect(unlocks(game(O_ROW, { you: 'O', ...level('hard') }))).toEqual(expect.arrayContaining(['o-win-medium', 'o-win-hard']));
    expect(unlocks(game(O_ROW, { you: 'O', ...level('hard') }))).not.toContain('o-win-person');
    const person = unlocks(game(O_ROW, { you: 'O', ...online('ana') }));
    expect(person).toContain('o-win-person');
    expect(person).not.toContain('o-win-medium');
  });

  it('reads the hide settings and the mode', () => {
    const hidden = { hideBoard: true, hideHistory: false, hideCoordinates: true };
    expect(unlocks(game(X_ROW, { options: hidden }))).toEqual(expect.arrayContaining(['board-hidden-easy', 'board-hidden-hard', 'coordinates-hidden']));
    expect(unlocks(game(X_ROW, { options: hidden, ...level('easy') }))).not.toContain('board-hidden-medium');
    expect(unlocks(game(X_ROW, { options: hidden, ...online('ana') }))).toContain('board-hidden-person');
    expect(unlocks(game(X_ROW, { options: hidden, ...online('ana') }))).not.toContain('board-hidden-easy');
    expect(unlocks(game(X_ROW, online('ana')))).toContain('online-win');
    expect(unlocks(game(X_ROW, { mode: 'nearby', difficulty: null }))).toContain('nearby-win');
  });

  it('counts a draw and every game, and a friend game with a winner as a win', () => {
    const progress = achievementProgress([game(DRAW, friend), game(O_ROW, friend)]);
    expect(unlocked(progress)).toEqual(['first-win', 'friend-game', 'full-cube']);
    expect(progressOf(progress, 'games-10')?.count).toBe(2);
    expect(progressOf(progress, 'friend-streak-5')?.count).toBe(2);
  });

  it('runs a computer streak over computer games only, at the level of the step or higher', () => {
    const medium = () => game(X_ROW, level('medium'));
    // An online loss is no computer game, so it does not break the run.
    const run = [medium(), game(O_ROW, online('ana')), medium(), game(X_ROW)];
    const progress = achievementProgress(run);
    expect(progressOf(progress, 'computer-streak-medium-3')).toMatchObject({ count: 3, unlockedBy: run.at(-1)?.id });
    expect(progressOf(progress, 'computer-streak-easy-5')?.count).toBe(3);
    expect(progressOf(progress, 'computer-streak-hard-2')?.count).toBe(1);
    // A win on Easy breaks a run on Medium.
    expect(progressOf(achievementProgress([medium(), game(X_ROW, level('easy')), medium()]), 'computer-streak-medium-3')?.count).toBe(1);
    expect(unlocks(game(X_ROW), game(X_ROW))).toContain('computer-streak-hard-2');
  });

  it('runs a people streak over online and Nearby games only', () => {
    const win = () => game(X_ROW, online('ana'));
    const games = [win(), win(), game(O_ROW), game(X_ROW, friend), game(O_ROW, online('ben')), win(), win()];
    expect(progressOf(achievementProgress(games), 'streak-3')?.count).toBe(2);
    const three = [win(), game(O_ROW), win(), win()];
    expect(progressOf(achievementProgress(three), 'streak-3')).toMatchObject({ count: 3, unlockedBy: three.at(-1)?.id });
  });

  it('knows each opponent: different people, a nemesis and a revenge', () => {
    const loss = (who: string) => game(O_ROW, online(who));
    const win = (who: string) => game(X_ROW, online(who));
    const people = achievementProgress(['a', 'b', 'a', 'c', 'd', 'b', 'e'].map(win));
    expect(progressOf(people, 'people-5')?.count).toBe(5);
    expect(progressOf(people, 'people-20')?.count).toBe(5);
    expect(unlocks(loss('a'), loss('a'), loss('b'), loss('a'))).toContain('nemesis');
    expect(unlocks(loss('a'), loss('a'), win('a'), loss('a'))).not.toContain('nemesis');
    expect(unlocks(loss('a'), win('b'), win('a'))).toContain('revenge');
    expect(unlocks(loss('a'), win('b'))).not.toContain('revenge');
    // The device does not know the opponent.
    expect(unlocks(game(O_ROW, { mode: 'online', difficulty: null }), game(X_ROW, { mode: 'online', difficulty: null }))).not.toContain('revenge');
  });

  it('knows a loss to Easy', () => {
    expect(unlocks(game(O_ROW, level('easy')))).toContain('lost-to-easy');
    expect(unlocks(game(O_ROW))).not.toContain('lost-to-easy');
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

describe('rarity', () => {
  it('counts the players who unlocked each achievement', () => {
    const winner = achievementProgress([game(X_ROW)]);
    const loser = achievementProgress([game(O_ROW)]);
    const rarity = rarityOf([winner, loser, achievementProgress([])]);
    expect(rarity.players).toBe(3);
    expect(rarity.unlocked['first-win']).toBe(1);
    expect(rarity.unlocked['games-10']).toBe(0);
  });

  it('shows a share as Steam does, and nothing without players', () => {
    const rarity = (unlocked: number, players: number): AchievementRarity => ({ players, unlocked: { ...rarityOf([]).unlocked, 'first-win': unlocked } });
    expect(rarityLabel(rarity(1, 8), 'first-win')).toBe('13%');
    expect(rarityLabel(rarity(1, 500), 'first-win')).toBe('<1%');
    expect(rarityLabel(rarity(0, 500), 'first-win')).toBe('0%');
    expect(rarityLabel(rarity(0, 0), 'first-win')).toBeNull();
  });
});

describe('parseAchievements', () => {
  const answer = (progress: AchievementProgress[], rarity = rarityOf([progress])) => JSON.parse(JSON.stringify({ achievements: progress, rarity })) as unknown;

  it('reads the answer of the server back', () => {
    const progress = achievementProgress([game(X_ROW), game(X_SPACE)]);
    expect(parseAchievements(answer(progress))).toEqual({ achievements: progress, rarity: rarityOf([progress]) });
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

  it('refuses a rarity with more unlocks than players, or without an achievement', () => {
    const progress = achievementProgress([game(X_ROW)]);
    const rarity = rarityOf([progress]);
    expect(parseAchievements(answer(progress, { ...rarity, players: 0 }))).toBeUndefined();
    const { 'first-win': _, ...missing } = rarity.unlocked;
    expect(parseAchievements(answer(progress, { ...rarity, unlocked: missing as AchievementRarity['unlocked'] }))).toBeUndefined();
  });
});

describe('invite achievements', () => {
  it('unlock at the claim that reaches the goal, in any order, with no game', () => {
    const invites = [50, 10, 40, 30, 20].map(ms);
    const progress = achievementProgress([game(X_ROW)], { direct: invites, second: [] });
    expect(progressOf(progress, 'invite-1')).toEqual({ id: 'invite-1', count: 1, unlockedAt: ms(10), unlockedBy: null });
    expect(progressOf(progress, 'invite-5')).toEqual({ id: 'invite-5', count: 5, unlockedAt: ms(50), unlockedBy: null });
    expect(progressOf(progress, 'invite-25')).toEqual({ id: 'invite-25', count: 5, unlockedAt: null, unlockedBy: null });
    // The answer of the server with invites passes the same checks on the page.
    expect(parseAchievements(JSON.parse(JSON.stringify({ achievements: progress, rarity: rarityOf([progress]) })))?.achievements).toEqual(progress);
  });

  it('stay locked without invites, as on a device', () => {
    expect(unlocks(game(X_ROW)).filter((id) => id.startsWith('invite-'))).toEqual([]);
  });
});

describe('the invite pair', () => {
  // The player invited the opponent (or the opponent invited the player) at 1 s; the games finish after that.
  const invite = ms(1);

  it('unlock for the inviter who loses, and for the invited person who wins, online or over Wi-Fi', () => {
    expect(unlocks(game(O_ROW, { ...online('bob'), invitedOpponentAt: invite }))).toContain('beaten-by-invitee');
    expect(unlocks(game(X_ROW, { ...online('alice'), mode: 'nearby', invitedByOpponentAt: invite }))).toContain('beat-inviter');
  });

  it('need the right outcome: a win over your invitee or a loss to your inviter counts for neither', () => {
    const ids = unlocks(game(X_ROW, { ...online('bob'), invitedOpponentAt: invite }), game(O_ROW, { ...online('alice'), invitedByOpponentAt: invite }));
    expect(ids).not.toContain('beaten-by-invitee');
    expect(ids).not.toContain('beat-inviter');
  });

  it('count no game before the invite', () => {
    const early = game(X_ROW, online('alice'));
    expect(unlocks({ ...early, invitedByOpponentAt: early.finishedAt })).not.toContain('beat-inviter');
    expect(unlocks({ ...early, invitedByOpponentAt: ms(early.finishedAt + 1) })).not.toContain('beat-inviter');
  });

  it('count no friend game and no computer game', () => {
    expect(unlocks(game(X_ROW, { ...friend, invitedByOpponentAt: invite }), game(X_ROW, { invitedByOpponentAt: invite }))).not.toContain('beat-inviter');
  });
});

describe('Family tree', () => {
  it('unlocks at the first person that an invitee of the player brings, and not for a direct invite', () => {
    const progress = achievementProgress([], { direct: [ms(10)], second: [ms(30), ms(20)] });
    expect(progressOf(progress, 'family-tree')).toEqual({ id: 'family-tree', count: 1, unlockedAt: ms(20), unlockedBy: null });
    expect(unlocked(achievementProgress([], { direct: [ms(10), ms(20)], second: [] }))).not.toContain('family-tree');
  });
});

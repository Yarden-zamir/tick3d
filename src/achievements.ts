// Achievements: goals that a player reaches over their finished games. The server and the device
// run the same rules, so past games count, and a device without a network shows its own games.
// The rules are pure: each one reads one finished game.
import type { Difficulty } from './ai.ts';
import { hasLimit } from './clock.ts';
import { type EpochMs, isEpochMs } from './epoch.ts';
import { type Game, type Player, lineKind } from './game.ts';
import { isCount, isRecord, isUnknownArray } from './guards.ts';
import { type GameId, type GameRecord, type MatchOptions, type Outcome, type SessionMode, outcomeOf, parseGameId, toGame } from './protocol.ts';

// One finished game of the player, as the server and the device both hold it.
export type AchievementGame = {
  // Null for a game from before game links.
  id: GameId | null;
  mode: SessionMode;
  game: GameRecord;
  // The seat of the player. Null when the player held both seats, as in a friend game.
  you: Player | null;
  difficulty: Difficulty | null;
  options: MatchOptions;
  tuned: boolean;
  finishedAt: EpochMs;
};

// A game with its replayed end, which the rules read.
type PlayedGame = AchievementGame & { end: Game; outcome: Outcome };

// count: the goal is a number of games that pass the test.
// streak: the goal is a run of games in a row that pass the test.
type Rule = {
  id: string;
  name: string;
  description: string;
  // The color of the badge: how hard the goal is.
  tier: 'bronze' | 'silver' | 'gold';
  goal: number;
  kind: 'count' | 'streak';
  test: (game: PlayedGame) => boolean;
};

const won = (game: PlayedGame) => game.outcome === 'won';
// A tuned computer plays another game, so it does not count for a level.
const beat = (level: Difficulty) => (game: PlayedGame) => won(game) && game.mode === 'computer' && game.difficulty === level && !game.tuned;
const wonByLine = (game: PlayedGame) => won(game) && game.end.status.kind === 'won';

// The fewest moves of a win: 4 marks of X, with 3 marks of O between them.
const FASTEST_WIN = 7;

export const ACHIEVEMENTS = [
  { id: 'first-win', name: 'First win', description: 'Win a game.', tier: 'bronze', goal: 1, kind: 'count', test: won },
  { id: 'beat-easy', name: 'Warm-up', description: 'Beat the computer on Easy.', tier: 'bronze', goal: 1, kind: 'count', test: beat('easy') },
  { id: 'beat-medium', name: 'Getting serious', description: 'Beat the computer on Medium.', tier: 'silver', goal: 1, kind: 'count', test: beat('medium') },
  { id: 'beat-hard', name: 'Machine breaker', description: 'Beat the computer on Hard.', tier: 'gold', goal: 1, kind: 'count', test: beat('hard') },
  {
    id: 'fastest-win',
    name: 'Seven moves',
    description: 'Win in 7 moves, the fewest possible.',
    tier: 'gold',
    goal: 1,
    kind: 'count',
    test: (game) => wonByLine(game) && game.game.moves.length === FASTEST_WIN,
  },
  {
    id: 'space-diagonal',
    name: 'Through the core',
    description: 'Win with a diagonal through the cube.',
    tier: 'silver',
    goal: 1,
    kind: 'count',
    test: (game) => game.end.status.kind === 'won' && won(game) && lineKind(game.end.status.line) === 'space',
  },
  { id: 'board-hidden', name: 'Blindfold', description: 'Win with the board hidden.', tier: 'gold', goal: 1, kind: 'count', test: (game) => won(game) && game.options.hideBoard },
  {
    id: 'coordinates-hidden',
    name: 'By ear',
    description: 'Win with the coordinates hidden.',
    tier: 'silver',
    goal: 1,
    kind: 'count',
    test: (game) => won(game) && game.options.hideCoordinates,
  },
  { id: 'timed-win', name: 'Against the clock', description: 'Win a game with a time limit.', tier: 'bronze', goal: 1, kind: 'count', test: (game) => won(game) && hasLimit(game.game.clock) },
  { id: 'streak-3', name: 'Hat trick', description: 'Win 3 games in a row.', tier: 'silver', goal: 3, kind: 'streak', test: won },
  { id: 'streak-5', name: 'On fire', description: 'Win 5 games in a row.', tier: 'gold', goal: 5, kind: 'streak', test: won },
  { id: 'online-win', name: 'Worthy opponent', description: 'Beat a person online.', tier: 'silver', goal: 1, kind: 'count', test: (game) => won(game) && game.mode === 'online' },
  { id: 'nearby-win', name: 'Face to face', description: 'Beat a person in Nearby.', tier: 'silver', goal: 1, kind: 'count', test: (game) => won(game) && game.mode === 'nearby' },
  { id: 'full-cube', name: 'Full cube', description: 'Play a game to a draw: the cube fills up.', tier: 'bronze', goal: 1, kind: 'count', test: (game) => game.end.status.kind === 'draw' },
  { id: 'games-10', name: 'Regular', description: 'Play 10 games.', tier: 'bronze', goal: 10, kind: 'count', test: () => true },
  { id: 'games-100', name: 'Centurion', description: 'Play 100 games.', tier: 'gold', goal: 100, kind: 'count', test: () => true },
] as const satisfies readonly Rule[];

export type Achievement = (typeof ACHIEVEMENTS)[number];
export type AchievementId = Achievement['id'];
export const ACHIEVEMENT_IDS: readonly AchievementId[] = ACHIEVEMENTS.map((achievement) => achievement.id);

// How far the player is with one achievement. `count` stops at the goal.
// unlockedAt and unlockedBy name the game that reached the goal: null while the goal is not reached,
// and unlockedBy is also null for a game from before game links.
export type AchievementProgress = { id: AchievementId; count: number; unlockedAt: EpochMs | null; unlockedBy: GameId | null };

// The progress of every achievement, in the order of ACHIEVEMENTS. The games can come in any order.
export function achievementProgress(games: readonly AchievementGame[]): AchievementProgress[] {
  const played = games
    .toSorted((a, b) => a.finishedAt - b.finishedAt)
    .map((game): PlayedGame => {
      const end = toGame(game.game);
      if (end.status.kind === 'playing') throw new Error('an achievement game is not finished');
      const winner = end.status.kind === 'draw' ? null : end.status.winner;
      // The player of a friend game held both seats, so a win of either seat is their win.
      const outcome = game.you === null ? (winner === null ? 'drawn' : 'won') : outcomeOf(winner, game.you);
      return { ...game, end, outcome };
    });
  return ACHIEVEMENTS.map((rule) => progressOf(rule, played));
}

function progressOf(rule: Achievement, games: readonly PlayedGame[]): AchievementProgress {
  let best = 0;
  let run = 0;
  let unlocked: PlayedGame | undefined;
  for (const game of games) {
    if (rule.kind === 'streak') {
      run = rule.test(game) ? run + 1 : 0;
      best = Math.max(best, run);
    } else if (rule.test(game)) {
      best++;
    }
    if (unlocked === undefined && best >= rule.goal) unlocked = game;
  }
  return {
    id: rule.id,
    count: Math.min(best, rule.goal),
    unlockedAt: unlocked?.finishedAt ?? null,
    unlockedBy: unlocked?.id ?? null,
  };
}

export function achievementOf(id: AchievementId): Achievement {
  const found = ACHIEVEMENTS.find((achievement) => achievement.id === id);
  if (found === undefined) throw new Error(`unknown achievement ${id}`);
  return found;
}

// How rare each achievement is, as in Steam: how many players unlocked it, out of every player with a finished game.
export type AchievementRarity = { players: number; unlocked: Record<AchievementId, number> };

// The answer of GET /api/me/achievements, and the achievements of a person on the stats page.
export type Achievements = { achievements: AchievementProgress[]; rarity: AchievementRarity };

// The rarity over the progress of every player, one list per player.
const emptyCounts = () => Object.fromEntries(ACHIEVEMENT_IDS.map((id) => [id, 0])) as Record<AchievementId, number>;

export function rarityOf(players: readonly (readonly AchievementProgress[])[]): AchievementRarity {
  const unlocked = emptyCounts();
  for (const progress of players) for (const entry of progress) if (entry.unlockedAt !== null) unlocked[entry.id] += 1;
  return { players: players.length, unlocked };
}

// The share of players who unlocked an achievement, as Steam shows it: "12%", or "<1%" for a few.
// Null without players.
export function rarityLabel(rarity: AchievementRarity, id: AchievementId): string | null {
  if (rarity.players === 0) return null;
  const percent = (rarity.unlocked[id] / rarity.players) * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function parseProgress(value: unknown): AchievementProgress[] | undefined {
  if (!isUnknownArray(value) || value.length !== ACHIEVEMENTS.length) return undefined;
  const parsed: AchievementProgress[] = [];
  for (const [index, item] of value.entries()) {
    const rule = ACHIEVEMENTS[index];
    if (rule === undefined || !isRecord(item) || item.id !== rule.id || !isCount(item.count) || item.count > rule.goal) return undefined;
    const { unlockedAt, unlockedBy } = item;
    if (unlockedAt !== null && !isEpochMs(unlockedAt)) return undefined;
    const by = unlockedBy === null ? null : parseGameId(unlockedBy);
    if (by === undefined || (unlockedAt === null) !== (item.count < rule.goal) || (unlockedAt === null && by !== null)) return undefined;
    parsed.push({ id: rule.id, count: item.count, unlockedAt, unlockedBy: by });
  }
  return parsed;
}

function parseRarity(value: unknown): AchievementRarity | undefined {
  if (!isRecord(value) || !isCount(value.players) || !isRecord(value.unlocked)) return undefined;
  const { players, unlocked } = value;
  if (Object.keys(unlocked).length !== ACHIEVEMENT_IDS.length) return undefined;
  const counted = emptyCounts();
  for (const id of ACHIEVEMENT_IDS) {
    const count = unlocked[id];
    if (!isCount(count) || count > players) return undefined;
    counted[id] = count;
  }
  return { players, unlocked: counted };
}

// Undefined unless the progress holds every achievement once, in order, and the rarity counts every achievement.
export function parseAchievements(value: unknown): Achievements | undefined {
  if (!isRecord(value)) return undefined;
  const achievements = parseProgress(value.achievements);
  const rarity = parseRarity(value.rarity);
  return achievements === undefined || rarity === undefined ? undefined : { achievements, rarity };
}

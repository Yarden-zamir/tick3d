// Achievements: goals that a player reaches over their finished games. The server and the device
// run the same rules, so past games count, and a device without a network shows its own games.
// The rules are pure: each one reads one finished game.
import { DIFFICULTIES, type Difficulty } from './ai.ts';
import { hasLimit, remaining } from './clock.ts';
import { type EpochMs, isEpochMs } from './epoch.ts';
import { CELL_COUNT, type Game, type Player, emptyCells, lineKind, replay, toCoords, winningLine } from './game.ts';
import { isCount, isRecord, isUnknownArray } from './guards.ts';
import { type GameId, type GameRecord, type MatchOptions, type Metrics, type Outcome, type SessionMode, outcomeOf, parseGameId, toGame } from './protocol.ts';

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
  // A key of the person in the other seat of an online or Nearby game, the same in each of their games.
  // Only the server knows it: null on the device, and for the computer and a friend game.
  opponent: string | null;
  // How the player placed their moves, from the metrics of their device. Null without them, as in an online game.
  input: Metrics['input'] | null;
};

// The opponent: a computer level, or a person online or in Nearby.
// A friend game and a tuned computer have no level, so they count for no ladder.
type Level = Difficulty | 'person';

// A game with its replayed end, which the rules read.
type PlayedGame = AchievementGame & {
  end: Game;
  outcome: Outcome;
  level: Level | null;
  // The outcomes of the earlier games against the same opponent, oldest first. Empty without an opponent.
  rivalry: readonly Outcome[];
};

// The colors of the badges, from the easiest goals to the rarest. stone is for easy goals, mythic for the rarest.
const TIERS = ['stone', 'bronze', 'silver', 'gold', 'mythic'] as const;

// count: the goal is a number of games that pass the test.
// streak: the goal is a run of games in a row that pass the test. Only the games of `among` make or break the run.
type Rule = {
  id: string;
  name: string;
  description: string;
  // The color of the badge: how hard the goal is.
  tier: (typeof TIERS)[number];
  // A hidden achievement shows as a question mark until the player unlocks it.
  hidden: boolean;
  goal: number;
  test: (game: PlayedGame) => boolean;
} & ({ kind: 'count' } | { kind: 'streak'; among: (game: PlayedGame) => boolean });

const won = (game: PlayedGame) => game.outcome === 'won';
const lost = (game: PlayedGame) => game.outcome === 'lost';
const wonByLine = (game: PlayedGame) => won(game) && game.end.status.kind === 'won';
// A computer game at this level or a harder one: a ladder step also unlocks with a game of a higher step.
// A person never counts for a computer level; the goals for people are their own achievements.
const atLeast = (level: Difficulty) => (game: PlayedGame) =>
  game.level !== null && game.level !== 'person' && DIFFICULTIES.indexOf(game.level) >= DIFFICULTIES.indexOf(level);
const wonAtLeast = (level: Difficulty) => (game: PlayedGame) => won(game) && atLeast(level)(game);
const againstComputer = (game: PlayedGame) => game.level !== null && game.level !== 'person';
const againstPerson = (game: PlayedGame) => game.level === 'person';

// The fewest moves of a win: 4 marks of X, with 3 marks of O between them.
const FASTEST_WIN = 7;
const fastest = (game: PlayedGame) => wonByLine(game) && game.game.moves.length === FASTEST_WIN;
const spaceDiagonal = (game: PlayedGame) => game.end.status.kind === 'won' && won(game) && lineKind(game.end.status.line) === 'space';
// A straight line down through all 4 floors: only the floor changes along it.
function elevator(game: PlayedGame): boolean {
  if (game.end.status.kind !== 'won' || !won(game)) return false;
  const [a, b] = game.end.status.line.map(toCoords);
  return a !== undefined && b !== undefined && a.row === b.row && a.column === b.column;
}

// A time limit of at most `perMove` seconds per move or `perGame` seconds per player.
const limitAtMost = (perMove: number, perGame: number) => (game: PlayedGame) => {
  const { clock } = game.game;
  return (clock.perMove !== null && clock.perMove <= perMove) || (clock.perGame !== null && clock.perGame <= perGame);
};
// Less than this many milliseconds on the clock of the winner after the winning move.
const PHOTO_FINISH_MS = 1000;
function photoFinish(game: PlayedGame): boolean {
  if (game.end.status.kind !== 'won' || !won(game) || game.you === null) return false;
  const clocks = remaining(game.end, game.end.times.at(-1) ?? game.finishedAt);
  if (clocks === null) return false;
  const { times, clock } = game.end;
  // remaining() keeps the move clock of a finished game full, so the winning move counts here.
  const lastMove = (times.at(-1) ?? 0) - (times.at(-2) ?? 0);
  const moveLeft = clock.perMove === null ? Infinity : clock.perMove * 1000 - lastMove;
  return Math.min(clocks[game.you].game ?? Infinity, moveLeft) < PHOTO_FINISH_MS;
}
// The move of the winner before the winning move left two cells to win on: the opponent could block only one.
function fork(game: PlayedGame): boolean {
  if (game.end.status.kind !== 'won' || !won(game)) return false;
  const { winner } = game.end.status;
  const before = replay(game.end.moves.slice(0, -2)).board;
  return emptyCells(before).filter((cell) => winningLine(before.with(cell, winner), cell, winner) !== undefined).length >= 2;
}

export const ACHIEVEMENTS = [
  { id: 'first-win', name: 'First win', description: 'Win a game.', tier: 'stone', hidden: false, goal: 1, kind: 'count', test: won },
  { id: 'games-10', name: 'Regular', description: 'Play 10 games.', tier: 'bronze', hidden: false, goal: 10, kind: 'count', test: () => true },
  { id: 'games-100', name: 'Centurion', description: 'Play 100 games.', tier: 'gold', hidden: false, goal: 100, kind: 'count', test: () => true },
  {
    id: 'beat-easy',
    name: 'Warm-up',
    description: 'Beat the computer on Easy or harder.',
    tier: 'stone',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: wonAtLeast('easy'),
  },
  {
    id: 'beat-medium',
    name: 'Getting serious',
    description: 'Beat the computer on Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: wonAtLeast('medium'),
  },
  {
    id: 'beat-hard',
    name: 'Machine breaker',
    description: 'Beat the computer on Hard.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: wonAtLeast('hard'),
  },
  {
    id: 'fastest-easy',
    name: 'Quick hands',
    description: 'Win in 7 moves, the fewest possible, against Easy or harder.',
    tier: 'stone',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => fastest(game) && atLeast('easy')(game),
  },
  {
    id: 'fastest-medium',
    name: 'Lightning',
    description: 'Win in 7 moves against Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => fastest(game) && atLeast('medium')(game),
  },
  {
    id: 'fastest-person',
    name: 'Seven wonders',
    description: 'Win in 7 moves against a person online or over Wi-Fi.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => fastest(game) && againstPerson(game),
  },
  {
    id: 'space-diagonal-easy',
    name: 'Peek inside',
    description: 'Win with a diagonal through the cube, against Easy or harder.',
    tier: 'stone',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => spaceDiagonal(game) && atLeast('easy')(game),
  },
  {
    id: 'space-diagonal-medium',
    name: 'Through the core',
    description: 'Win with a diagonal through the cube, against Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => spaceDiagonal(game) && atLeast('medium')(game),
  },
  {
    id: 'space-diagonal-hard',
    name: 'Core breach',
    description: 'Win with a diagonal through the cube, against Hard.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => spaceDiagonal(game) && atLeast('hard')(game),
  },
  {
    id: 'space-diagonal-person',
    name: 'Inside job',
    description: 'Win with a diagonal through the cube, against a person online or over Wi-Fi.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => spaceDiagonal(game) && againstPerson(game),
  },
  {
    id: 'board-hidden-easy',
    name: 'Squint',
    description: 'Win with the board hidden, against Easy or harder.',
    tier: 'stone',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => wonAtLeast('easy')(game) && game.options.hideBoard,
  },
  {
    id: 'board-hidden-medium',
    name: 'Blindfold',
    description: 'Win with the board hidden, against Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => wonAtLeast('medium')(game) && game.options.hideBoard,
  },
  {
    id: 'board-hidden-hard',
    name: 'Bat sense',
    description: 'Win with the board hidden, against Hard.',
    tier: 'mythic',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => wonAtLeast('hard')(game) && game.options.hideBoard,
  },
  {
    id: 'board-hidden-person',
    name: 'Blind date',
    description: 'Win with the board hidden, against a person online or over Wi-Fi.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && againstPerson(game) && game.options.hideBoard,
  },
  {
    id: 'computer-streak-easy-5',
    name: 'Lullaby',
    description: 'Win 5 games in a row against the computer on Easy or harder.',
    tier: 'stone',
    hidden: false,
    goal: 5,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('easy'),
  },
  {
    id: 'computer-streak-medium-3',
    name: 'Tune-up',
    description: 'Win 3 games in a row against the computer on Medium or harder.',
    tier: 'bronze',
    hidden: false,
    goal: 3,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('medium'),
  },
  {
    id: 'computer-streak-medium-5',
    name: 'Overheat',
    description: 'Win 5 games in a row against the computer on Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 5,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('medium'),
  },
  {
    id: 'computer-streak-medium-10',
    name: 'Factory reset',
    description: 'Win 10 games in a row against the computer on Medium or harder.',
    tier: 'gold',
    hidden: false,
    goal: 10,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('medium'),
  },
  {
    id: 'computer-streak-hard-2',
    name: 'Short circuit',
    description: 'Win 2 games in a row against the computer on Hard.',
    tier: 'mythic',
    hidden: false,
    goal: 2,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('hard'),
  },
  {
    id: 'computer-streak-hard-5',
    name: 'Singularity',
    description: 'Win 5 games in a row against the computer on Hard.',
    tier: 'mythic',
    hidden: false,
    goal: 5,
    kind: 'streak',
    among: againstComputer,
    test: wonAtLeast('hard'),
  },
  {
    id: 'streak-3',
    name: 'Hat trick',
    description: 'Win 3 games in a row against people online or over Wi-Fi.',
    tier: 'silver',
    hidden: false,
    goal: 3,
    kind: 'streak',
    among: againstPerson,
    test: won,
  },
  {
    id: 'streak-5',
    name: 'On fire',
    description: 'Win 5 games in a row against people online or over Wi-Fi.',
    tier: 'gold',
    hidden: false,
    goal: 5,
    kind: 'streak',
    among: againstPerson,
    test: won,
  },
  {
    id: 'timed-win',
    name: 'Against the clock',
    description: 'Win a game with a time limit.',
    tier: 'bronze',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && hasLimit(game.game.clock),
  },
  {
    id: 'timed-win-short',
    name: 'Short fuse',
    description: 'Win with 10 s per move or 2 min per player, or less. Not in a friend game.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.you !== null && limitAtMost(10, 120)(game),
  },
  {
    id: 'timed-win-bullet',
    name: 'Bullet',
    description: 'Win with 5 s per move or 1 min per player, or less. Not in a friend game.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.you !== null && limitAtMost(5, 60)(game),
  },
  {
    id: 'won-on-time',
    name: 'Flag fall',
    description: 'Beat a person online or over Wi-Fi when their time runs out.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && againstPerson(game) && game.end.status.kind === 'timeout',
  },
  {
    id: 'o-win-medium',
    name: 'Second wind',
    description: 'Win as O, who moves second, against Medium or harder.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => game.you === 'O' && wonAtLeast('medium')(game),
  },
  {
    id: 'o-win-hard',
    name: 'Underdog',
    description: 'Win as O against Hard.',
    tier: 'gold',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => game.you === 'O' && wonAtLeast('hard')(game),
  },
  {
    id: 'o-win-person',
    name: 'Counterpunch',
    description: 'Win as O against a person online or over Wi-Fi.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => game.you === 'O' && won(game) && againstPerson(game),
  },
  {
    id: 'online-win',
    name: 'Worthy opponent',
    description: 'Beat a person online.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.mode === 'online',
  },
  {
    id: 'nearby-win',
    name: 'Face to face',
    description: 'Beat a person over Wi-Fi.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.mode === 'nearby',
  },
  // Each first game against a new opponent counts once.
  {
    id: 'people-5',
    name: 'Social butterfly',
    description: 'Play against 5 different people online or over Wi-Fi.',
    tier: 'silver',
    hidden: false,
    goal: 5,
    kind: 'count',
    test: (game: PlayedGame) => game.opponent !== null && game.rivalry.length === 0,
  },
  {
    id: 'people-20',
    name: 'Crowd favorite',
    description: 'Play against 20 different people online or over Wi-Fi.',
    tier: 'gold',
    hidden: false,
    goal: 20,
    kind: 'count',
    test: (game: PlayedGame) => game.opponent !== null && game.rivalry.length === 0,
  },
  {
    id: 'friend-game',
    name: 'Pass the phone',
    description: 'Play a friend game on one device.',
    tier: 'stone',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => game.mode === 'friend',
  },
  {
    id: 'friend-streak-5',
    name: 'Game night',
    description: 'Play 5 friend games in a row.',
    tier: 'bronze',
    hidden: false,
    goal: 5,
    kind: 'streak',
    among: () => true,
    test: (game: PlayedGame) => game.mode === 'friend',
  },
  {
    id: 'coordinates-hidden',
    name: 'By ear',
    description: 'Win with the coordinates hidden.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.options.hideCoordinates,
  },
  {
    id: 'elevator',
    name: 'Elevator',
    description: 'Win with a straight line down through all 4 floors.',
    tier: 'bronze',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: elevator,
  },
  {
    id: 'fork',
    name: 'Fork',
    description: 'Win with two cells to win on at once, against Medium, Hard or a person.',
    tier: 'silver',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => fork(game) && (atLeast('medium')(game) || againstPerson(game)),
  },
  {
    id: 'full-cube',
    name: 'Full cube',
    description: 'Play a game to a draw: the cube fills up.',
    tier: 'bronze',
    hidden: false,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => game.end.status.kind === 'draw',
  },
  {
    id: 'sound-only',
    name: 'Echolocation',
    description: 'Beat the computer on Hard with the board hidden, with every move placed by your voice.',
    tier: 'mythic',
    hidden: true,
    goal: 1,
    kind: 'count',
    // Limit: an online game has no metrics in its result, so only a computer game counts. Revisit this when
    // the online metrics (seat_metrics) reach the rules.
    test: (game: PlayedGame) =>
      won(game) &&
      game.level === 'hard' &&
      game.options.hideBoard &&
      game.input !== null &&
      game.input.board === 0 &&
      game.input.voice > 0 &&
      game.input.voice === game.input.keypad,
  },
  {
    id: 'nemesis',
    name: 'Nemesis',
    description: 'Lose 3 games in a row to the same person.',
    tier: 'bronze',
    hidden: true,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => lost(game) && game.rivalry.length >= 2 && game.rivalry.slice(-2).every((outcome) => outcome === 'lost'),
  },
  {
    id: 'revenge',
    name: 'Sweet revenge',
    description: 'Beat a person right after a loss to them.',
    tier: 'silver',
    hidden: true,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => won(game) && game.rivalry.at(-1) === 'lost',
  },
  {
    id: 'lost-to-easy',
    name: 'Humbled',
    description: 'Lose to the computer on Easy.',
    tier: 'stone',
    hidden: true,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => lost(game) && game.level === 'easy',
  },
  {
    id: 'photo-finish',
    name: 'Photo finish',
    description: 'Win with less than 1 s left on your clock. Not in a friend game.',
    tier: 'gold',
    hidden: true,
    goal: 1,
    kind: 'count',
    test: photoFinish,
  },
  {
    id: 'last-move',
    name: 'Last gasp',
    description: 'Win with the last free cell of the cube.',
    tier: 'gold',
    hidden: true,
    goal: 1,
    kind: 'count',
    test: (game: PlayedGame) => wonByLine(game) && game.end.moves.length === CELL_COUNT,
  },
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
  const rivalries = new Map<string, Outcome[]>();
  const played = games
    .toSorted((a, b) => a.finishedAt - b.finishedAt)
    .map((game): PlayedGame => {
      const end = toGame(game.game);
      if (end.status.kind === 'playing') throw new Error('an achievement game is not finished');
      const winner = end.status.kind === 'draw' ? null : end.status.winner;
      // The player of a friend game held both seats, so a win of either seat is their win.
      const outcome = game.you === null ? (winner === null ? 'drawn' : 'won') : outcomeOf(winner, game.you);
      const rivalry = game.opponent === null ? [] : (rivalries.get(game.opponent) ?? []);
      if (game.opponent !== null) rivalries.set(game.opponent, [...rivalry, outcome]);
      return { ...game, end, outcome, level: levelOf(game), rivalry };
    });
  return ACHIEVEMENTS.map((rule) => progressOf(rule, played));
}

function levelOf({ mode, you, difficulty, tuned }: AchievementGame): Level | null {
  if (you === null) return null;
  if (mode === 'online' || mode === 'nearby') return 'person';
  // A tuned computer plays another game, so it counts for no level.
  return mode === 'computer' && !tuned ? difficulty : null;
}

function progressOf(rule: Achievement, games: readonly PlayedGame[]): AchievementProgress {
  let best = 0;
  let run = 0;
  let unlocked: PlayedGame | undefined;
  for (const game of games) {
    if (rule.kind === 'streak') {
      if (!rule.among(game)) continue;
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

// The rarest tier first, so a strip with room for a few badges shows the best ones. The sort is stable.
export const rarestFirst = (ids: readonly AchievementId[]): AchievementId[] =>
  ids.toSorted((a, b) => TIERS.indexOf(achievementOf(b).tier) - TIERS.indexOf(achievementOf(a).tier));

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

import { describe, expect, it } from 'vitest';
import { chooseMove, DIFFICULTIES, type Position } from './ai.ts';
import { DEFAULT_TUNING, type Tuning } from './tuning.ts';
import { type Player, linesThrough, newGame, other, play, replay } from './game.ts';

// A game that ends with these marks and `turn` to move. The marks of the two players take turns in cell order.
// The order matters only to the sure first block of easy, and a test of that rule gives the moves itself.
function positionWith(marks: Record<number, Player>, turn: Player): Position {
  const cells = (player: Player) => Object.keys(marks).map(Number).filter((cell) => marks[cell] === player);
  const mine = cells(turn);
  const theirs = cells(other(turn));
  const first = mine.length === theirs.length ? turn : other(turn);
  if (theirs.length - mine.length !== (first === turn ? 0 : 1)) throw new Error(`${turn} cannot be to move with these marks`);
  const [a, b] = first === turn ? [mine, theirs] : [theirs, mine];
  return { moves: a.flatMap((cell, i) => [cell, ...b.slice(i, i + 1)]), first };
}

const fixed = () => 0.5;
const budget = (budgetMs: number): Tuning => ({ ...DEFAULT_TUNING, hard: { ...DEFAULT_TUNING.hard, budgetMs } });

describe('chooseMove', () => {
  it.each(DIFFICULTIES)('%s takes an immediate win', (difficulty) => {
    const position = positionWith({ 0: 'O', 1: 'O', 2: 'O', 20: 'X', 21: 'X', 22: 'X' }, 'O');
    expect(chooseMove(position, difficulty, fixed)).toBe(3);
  });

  it.each(['medium', 'hard'] as const)('%s blocks an immediate loss', (difficulty) => {
    const position = positionWith({ 0: 'X', 21: 'X', 42: 'X', 5: 'O', 9: 'O' }, 'O');
    expect(chooseMove(position, difficulty, fixed)).toBe(63);
  });

  it('hard makes a fork that wins next turn', () => {
    // O owns two lines that cross at cell 0, each with two marks: playing 0 makes two threats.
    // X has no line with three marks, so O does not need to block.
    const position = positionWith({ 1: 'O', 2: 'O', 16: 'O', 32: 'O', 63: 'X', 60: 'X', 42: 'X', 27: 'X' }, 'O');
    expect(chooseMove(position, 'hard', fixed, budget(2000))).toBe(0);
  });

  it.each(DIFFICULTIES)('%s only plays legal moves through a full game', (difficulty) => {
    let game = newGame();
    while (game.status.kind === 'playing') {
      const result = play(game, chooseMove(game, difficulty, Math.random, budget(50)));
      expect(result.ok).toBe(true);
      if (!result.ok) break;
      game = result.game;
    }
    expect(game.status.kind).not.toBe('playing');
  });

  it('medium makes a fork when it sees one', () => {
    // Cell 0 gives O two winning cells at once: 3 (row) and 48 (pillar).
    const position = positionWith({ 1: 'O', 2: 'O', 16: 'O', 32: 'O', 63: 'X', 60: 'X', 42: 'X', 27: 'X' }, 'O');
    expect(chooseMove(position, 'medium', () => 0.05)).toBe(0);
  });

  it("medium takes the cell of the opponent's fork when it sees it", () => {
    const position = positionWith({ 1: 'X', 2: 'X', 16: 'X', 32: 'X', 63: 'O', 60: 'O', 42: 'O', 27: 'O' }, 'O');
    expect(chooseMove(position, 'medium', () => 0.05)).toBe(0);
  });

  it('easy always blocks the first threat of a game', () => {
    // X threatens 63. O has not blocked a line of X yet.
    const position = positionWith({ 0: 'X', 21: 'X', 42: 'X', 5: 'O', 9: 'O' }, 'O');
    const neverBlocks = { ...DEFAULT_TUNING, easy: { ...DEFAULT_TUNING.easy, fresh: { ...DEFAULT_TUNING.easy.fresh, block: 0 }, tired: { ...DEFAULT_TUNING.easy.tired, block: 0 } } };
    let roll = 0;
    const cycling = () => (roll++ % 10) / 10;
    for (const random of [() => 0, () => 0.5, () => 0.999, Math.random, cycling]) {
      expect(chooseMove(position, 'easy', random)).toBe(63);
      expect(chooseMove(position, 'easy', random, neverBlocks)).toBe(63);
    }
  });

  it('easy blocks on a good day and misses the block on a bad one after its first block', () => {
    // X threatens 63 and O blocks it. Then X threatens 3 with the row 0..2.
    const position: Position = { moves: [0, 5, 21, 9, 42, 63, 1, 30, 2], first: 'X' };
    expect(chooseMove(position, 'easy', () => 0.1)).toBe(3);
    expect(chooseMove(position, 'easy', () => 0.999)).not.toBe(3);
  });

  it('easy does not count a line that it held before the threat as a block', () => {
    // O takes 3 first, and X fills the rest of the row 0..3 later: no block. Then X threatens 19 with the row 16..18.
    const position: Position = { moves: [0, 3, 1, 21, 2, 42, 16, 7, 17, 50, 18], first: 'X' };
    for (const random of [() => 0, () => 0.999]) expect(chooseMove(position, 'easy', random)).toBe(19);
  });

  it('medium always blocks while fresh, and misses some blocks when tired', () => {
    const position = positionWith({ 0: 'X', 21: 'X', 42: 'X', 5: 'O', 9: 'O' }, 'O');
    // A roll of 0.9 is above the tired block chance (0.85) and below the fresh one (1).
    // O has not blocked yet, so a miss here also shows that the sure first block is for easy only.
    expect(chooseMove(position, 'medium', () => 0.9)).toBe(63);
    const fresh = { ...DEFAULT_TUNING.medium, tireFrom: 60, tireTo: 64 };
    const tired = { ...DEFAULT_TUNING.medium, tireFrom: 0, tireTo: 1 };
    expect(chooseMove(position, 'medium', () => 0.9, { ...DEFAULT_TUNING, medium: fresh })).toBe(63);
    expect(chooseMove(position, 'medium', () => 0.9, { ...DEFAULT_TUNING, medium: tired })).not.toBe(63);
  });

  it('hard wins by threats in a row against a player who always blocks', () => {
    // No move gives O two winning cells at once here. O needs a threat, a forced block, then a fork.
    const marks: Record<number, Player> = { 0: 'X', 2: 'O', 3: 'X', 6: 'O', 9: 'X', 10: 'X', 14: 'O', 15: 'O', 22: 'X', 25: 'O', 26: 'O', 38: 'X', 41: 'O', 42: 'X', 54: 'X', 57: 'O', 60: 'X' };
    const { moves, first } = positionWith(marks, 'O');
    let game = replay(moves, { first });
    for (let turn = 0; turn < 6 && game.status.kind === 'playing'; turn++) {
      const level = game.turn === 'O' ? 'hard' : 'medium';
      const result = play(game, chooseMove(game, level, fixed, budget(2000)));
      if (!result.ok) throw new Error(result.error);
      game = result.game;
    }
    expect(game.status).toMatchObject({ kind: 'won', winner: 'O' });
  });

  it('opens on varied strong cells', () => {
    const empty: Position = { moves: [], first: 'X' };
    const firsts = new Set(Array.from({ length: 40 }, () => chooseMove(empty, 'hard')));
    expect(firsts.size).toBeGreaterThanOrEqual(4);
    for (const cell of firsts) expect(linesThrough(cell)).toHaveLength(7);
  });

  it('hard answers within its thinking time on a busy board', () => {
    const position = positionWith({ 0: 'X', 21: 'X', 63: 'O', 42: 'O', 5: 'X', 26: 'O', 47: 'X', 16: 'O', 37: 'X', 58: 'O' }, 'X');
    const start = performance.now();
    chooseMove(position, 'hard', fixed, budget(200));
    // The budget is checked at every search step, so one step of work is the only overrun.
    expect(performance.now() - start).toBeLessThan(200 + 150);
  });

  it('works when the level considers more cells than are empty', () => {
    // After the first move, fewer than 64 cells are empty.
    const tuning = { ...DEFAULT_TUNING, easy: { ...DEFAULT_TUNING.easy, candidates: 64 } };
    expect([0, 21]).not.toContain(chooseMove({ moves: [0, 21], first: 'X' }, 'easy', fixed, tuning));
  });

  it('throws on a finished game and on moves that are not a legal game', () => {
    // X completes the row 0..3 with its last move.
    expect(() => chooseMove({ moves: [0, 4, 1, 5, 2, 6, 3], first: 'X' }, 'easy')).toThrow('game is over');
    expect(() => chooseMove({ moves: [0, 0], first: 'X' }, 'easy')).toThrow();
  });
});

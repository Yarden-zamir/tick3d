import { describe, expect, it } from 'vitest';
import { chooseMove, DIFFICULTIES } from './ai.ts';
import { type Board, CELL_COUNT, type Mark, newGame, play } from './game.ts';

function boardWith(marks: Record<number, Mark>): Board {
  return Array.from({ length: CELL_COUNT }, (_, cell) => marks[cell] ?? null);
}

const fixed = () => 0.5;

describe('chooseMove', () => {
  it.each(DIFFICULTIES)('%s takes an immediate win', (difficulty) => {
    const board = boardWith({ 0: 'O', 1: 'O', 2: 'O', 20: 'X', 21: 'X', 22: 'X' });
    expect(chooseMove(board, 'O', difficulty, fixed)).toBe(3);
  });

  it.each(['medium', 'hard'] as const)('%s blocks an immediate loss', (difficulty) => {
    const board = boardWith({ 0: 'X', 21: 'X', 42: 'X', 5: 'O', 9: 'O' });
    expect(chooseMove(board, 'O', difficulty, fixed)).toBe(63);
  });

  it('hard makes a fork that wins next turn', () => {
    // O owns two lines that cross at cell 0, each with two marks: playing 0 makes two threats.
    // X has no line with three marks, so O does not need to block.
    const board = boardWith({ 1: 'O', 2: 'O', 16: 'O', 32: 'O', 63: 'X', 60: 'X', 42: 'X', 27: 'X' });
    expect(chooseMove(board, 'O', 'hard', fixed, 2000)).toBe(0);
  });

  it.each(DIFFICULTIES)('%s only plays legal moves through a full game', (difficulty) => {
    let game = newGame();
    while (game.status.kind === 'playing') {
      const result = play(game, chooseMove(game.board, game.turn, difficulty, Math.random, 50));
      expect(result.ok).toBe(true);
      if (!result.ok) break;
      game = result.game;
    }
    expect(game.status.kind).not.toBe('playing');
  });

  it('throws on a full board', () => {
    expect(() => chooseMove(boardWith(Object.fromEntries(Array.from({ length: CELL_COUNT }, (_, c) => [c, 'X']))), 'O', 'easy')).toThrow();
  });
});

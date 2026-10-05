import { describe, expect, it } from 'vitest';
import { chooseMove, DIFFICULTIES } from './ai.ts';
import { type Board, CELL_COUNT, type Mark, linesThrough, newGame, play, replay } from './game.ts';

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

  it('medium makes a fork when it sees one', () => {
    // Cell 0 gives O two winning cells at once: 3 (row) and 48 (pillar).
    const board = boardWith({ 1: 'O', 2: 'O', 16: 'O', 32: 'O', 63: 'X', 60: 'X', 42: 'X', 27: 'X' });
    expect(chooseMove(board, 'O', 'medium', () => 0.05)).toBe(0);
  });

  it("medium takes the cell of the opponent's fork when it sees it", () => {
    const board = boardWith({ 1: 'X', 2: 'X', 16: 'X', 32: 'X', 63: 'O', 60: 'O', 42: 'O', 27: 'O' });
    expect(chooseMove(board, 'O', 'medium', () => 0.05)).toBe(0);
  });

  it('easy blocks on a good day and misses the block on a bad one', () => {
    const board = boardWith({ 0: 'X', 21: 'X', 42: 'X', 5: 'O', 9: 'O' });
    expect(chooseMove(board, 'O', 'easy', () => 0.1)).toBe(63);
    expect(chooseMove(board, 'O', 'easy', () => 0.99)).not.toBe(63);
  });

  it('hard wins by threats in a row against a player who always blocks', () => {
    // No move gives O two winning cells at once here. O needs a threat, a forced block, then a fork.
    const marks: Record<number, Mark> = { 0: 'X', 2: 'O', 3: 'X', 6: 'O', 9: 'X', 10: 'X', 14: 'O', 15: 'O', 22: 'X', 25: 'O', 26: 'O', 38: 'X', 41: 'O', 42: 'X', 54: 'X', 57: 'O', 60: 'X' };
    const moves = Object.keys(marks).map(Number);
    let game = replay([], {});
    for (const cell of moves) game = { ...game, board: game.board.with(cell, marks[cell] ?? null) };
    game = { ...game, turn: 'O' };
    for (let turn = 0; turn < 6 && game.status.kind === 'playing'; turn++) {
      const level = game.turn === 'O' ? 'hard' : 'medium';
      const result = play(game, chooseMove(game.board, game.turn, level, fixed, 2000));
      if (!result.ok) throw new Error(result.error);
      game = result.game;
    }
    expect(game.status).toMatchObject({ kind: 'won', winner: 'O' });
  });

  it('opens on varied strong cells', () => {
    const empty = boardWith({});
    const firsts = new Set(Array.from({ length: 40 }, () => chooseMove(empty, 'X', 'hard')));
    expect(firsts.size).toBeGreaterThanOrEqual(4);
    for (const cell of firsts) expect(linesThrough(cell)).toHaveLength(7);
  });

  it('throws on a full board', () => {
    expect(() => chooseMove(boardWith(Object.fromEntries(Array.from({ length: CELL_COUNT }, (_, c) => [c, 'X']))), 'O', 'easy')).toThrow();
  });
});

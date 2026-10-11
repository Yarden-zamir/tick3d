import { describe, expect, it } from 'vitest';
import { type Level, chooseMove, forcedWin } from './ai.ts';
import { type Game, type Player, linesThrough, newGame, play, replay, threatCells, toCell } from './rules.ts';

const at = (cube: number, layer: number, row: number, column: number) => toCell({ cube, layer, row, column });

// A small seeded generator, so a failing game can be played again.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function playOut(levels: Record<Player, Level>, seed: number, budgetMs: number): Game {
  const random = seeded(seed);
  let game = newGame();
  while (game.status.kind === 'playing') {
    const cell = chooseMove(game.board, game.turn, levels[game.turn], random, budgetMs);
    const result = play(game, cell);
    if (!result.ok) throw new Error(`the computer played an illegal move: ${result.error} at ${cell}`);
    game = result.game;
  }
  return game;
}

describe('the Tesseract computer', () => {
  // X has three on the line through all four cubes; O has three on a line inside cube 3.
  const position = replay([at(0, 0, 0, 0), at(3, 0, 0, 1), at(1, 1, 1, 1), at(3, 0, 0, 2), at(2, 2, 2, 2), at(3, 0, 0, 3)]);

  it('takes a win at every level', () => {
    for (const level of ['easy', 'hard'] as const) {
      expect(chooseMove(position.board, 'X', level, seeded(1), 50)).toBe(at(3, 3, 3, 3));
    }
  });

  it('blocks a win on the hard level', () => {
    const game = replay([at(0, 0, 0, 0), at(3, 0, 0, 1), at(1, 1, 1, 1), at(3, 0, 0, 2), at(0, 1, 2, 3), at(3, 0, 0, 3)]);
    expect(threatCells(game.board, 'O')).toEqual([at(3, 0, 0, 0)]);
    expect(chooseMove(game.board, 'X', 'hard', seeded(1), 50)).toBe(at(3, 0, 0, 0));
  });

  it('opens on a strong cell', () => {
    for (const seed of [1, 2, 3, 4]) expect(linesThrough(chooseMove(newGame().board, 'X', 'hard', seeded(seed), 50))).toHaveLength(15);
  });

  // X has two lines of two that cross at an empty cell, both open: playing it makes two winning cells.
  it('finds a fork', () => {
    const game = replay([at(1, 0, 0, 0), at(3, 3, 0, 0), at(1, 0, 0, 1), at(3, 3, 0, 3), at(1, 1, 0, 3), at(3, 3, 3, 0), at(1, 2, 0, 3), at(3, 3, 3, 3)]);
    const board = [...game.board];
    const cell = forcedWin(board, 'X', 1, Infinity);
    expect(cell).toBe(at(1, 0, 0, 3));
    expect(board).toEqual(game.board);
  });

  it('plays whole games with only legal moves', () => {
    for (const seed of [1, 2, 3]) {
      const game = playOut({ X: 'easy', O: 'easy' }, seed, 10);
      expect(game.status.kind).not.toBe('playing');
    }
  });

  it('beats the easy level with the hard level', () => {
    const seeds = [11, 12, 13, 14, 15, 16];
    const wins = seeds.filter((seed) => {
      const hardFirst = seed % 2 === 0;
      const game = playOut(hardFirst ? { X: 'hard', O: 'easy' } : { X: 'easy', O: 'hard' }, seed, 40);
      return game.status.kind === 'won' && game.status.winner === (hardFirst ? 'X' : 'O');
    });
    expect(wins.length).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

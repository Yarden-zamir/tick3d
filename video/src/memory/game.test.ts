import { describe, expect, it } from 'vitest';
import { chooseMove } from '../../../src/ai.ts';
import { LINES, type Board, emptyCells, newGame, play, replay } from '../../../src/game.ts';
import { seededRandom } from '../../../src/practice/practice.ts';
import { FORK_MOVE, GAME, LEVELS, MOVES, SEED, THREAT_CELLS, THREAT_LINES, WIN_LINE, digitsOf, playerOf } from './game.ts';

// The cells where `player` wins with one more move.
const winsOf = (board: Board, player: 'X' | 'O') => emptyCells(board).filter((cell) => LINES.some((line) => line.includes(cell) && line.every((c) => c === cell || board[c] === player)));
const boardAfter = (move: number) => replay(MOVES.slice(0, move + 1)).board;

describe('the game of the smart-memory ad', () => {
  it('is the self-play of the seed, move for move', () => {
    const random = seededRandom(SEED);
    let game = newGame('X');
    while (game.status.kind === 'playing') {
      const result = play(game, chooseMove(game.board, game.turn, LEVELS[game.turn], random));
      if (!result.ok) throw new Error(result.error);
      game = result.game;
    }
    expect(game.moves).toEqual(MOVES);
  });

  it('ends with the win of X on the winning line', () => {
    expect(GAME.status).toEqual({ kind: 'won', winner: 'X', line: WIN_LINE });
  });

  it('has the double threat of X at the fork move, on the two threat lines, and no earlier one', () => {
    expect(playerOf(FORK_MOVE)).toBe('X');
    expect(winsOf(boardAfter(FORK_MOVE), 'X').toSorted((a, b) => a - b)).toEqual(THREAT_CELLS);
    for (let move = 0; move < FORK_MOVE; move += 2) expect(winsOf(boardAfter(move), 'X').length).toBeLessThan(2);
    THREAT_LINES.forEach((line, i) => {
      expect(LINES).toContainEqual(line);
      expect(line).toContain(THREAT_CELLS[i]);
      expect(line.filter((cell) => cell !== THREAT_CELLS[i]).every((cell) => boardAfter(FORK_MOVE)[cell] === 'X')).toBe(true);
    });
  });

  it('has O block the first threat, then X win on the second', () => {
    expect(MOVES[FORK_MOVE + 1]).toBe(THREAT_CELLS[0]);
    expect(MOVES[FORK_MOVE + 2]).toBe(THREAT_CELLS[1]);
    expect(MOVES).toHaveLength(FORK_MOVE + 3);
  });

  it('shows the keypad digits of a cell from 1', () => {
    expect(digitsOf(0)).toEqual([1, 1, 1]);
    expect(digitsOf(63)).toEqual([4, 4, 4]);
    expect(digitsOf(30)).toEqual([2, 4, 3]);
  });
});

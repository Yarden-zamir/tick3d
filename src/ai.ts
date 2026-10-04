import { type Board, type Mark, type Player, emptyCells, LINES, linesThrough, other, winningLine } from './game';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type Random = () => number;

// Line weights by the number of marks one player has in a line that the other player does not block.
const LINE_WEIGHT = [0, 1, 12, 150, 0] as const;
const WIN = 1_000_000;
// The hard search looks at the best few moves per position only. Raise this if the hard level
// misses tactics, but each step costs search depth inside the same time budget.
const BRANCHING = 10;
const HARD_TIME_BUDGET_MS = 600;

// The cell that completes a line of `player` now, if one exists.
export function findWin(board: Board, player: Player): number | undefined {
  return emptyCells(board).find((cell) => winningLine(board.with(cell, player), cell, player));
}

// How much a move helps `player`: lines it builds plus enemy lines it blocks.
export function moveScore(board: Board, cell: number, player: Player): number {
  let score = 0;
  for (const line of linesThrough(cell)) {
    let mine = 0;
    let theirs = 0;
    for (const c of line) {
      if (board[c] === player) mine++;
      else if (board[c] !== null) theirs++;
    }
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3];
    if (mine === 0) score += LINE_WEIGHT[theirs as 0 | 1 | 2 | 3] * 0.9;
  }
  return score;
}

// Static value of a position for `player`: open lines for them minus open lines for the opponent.
export function evaluate(board: Board, player: Player): number {
  let score = 0;
  for (const line of LINES) {
    let mine = 0;
    let theirs = 0;
    for (const c of line) {
      if (board[c] === player) mine++;
      else if (board[c] !== null) theirs++;
    }
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3 | 4];
    else if (mine === 0) score -= LINE_WEIGHT[theirs as 0 | 1 | 2 | 3 | 4];
  }
  return score;
}

function rankedMoves(board: Board, player: Player): number[] {
  return emptyCells(board)
    .map((cell) => ({ cell, score: moveScore(board, cell, player) }))
    .sort((a, b) => b.score - a.score)
    .map(({ cell }) => cell);
}

function pick<T>(items: readonly T[], random: Random): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('cannot pick from an empty list');
  return item;
}

class Timeout extends Error {}

// Negamax with alpha-beta pruning. Returns the value of the position for `player`, who moves next.
function search(board: Mark[], player: Player, depth: number, alpha: number, beta: number, deadline: number): number {
  if (performance.now() > deadline) throw new Timeout();
  const moves = rankedMoves(board, player).slice(0, BRANCHING);
  if (moves.length === 0) return 0;
  for (const cell of moves) {
    board[cell] = player;
    const score = winningLine(board, cell, player)
      ? WIN + depth
      : depth <= 1
        ? evaluate(board, player)
        : -search(board, other(player), depth - 1, -beta, -alpha, deadline);
    board[cell] = null;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// Iterative deepening: keep the best move of the deepest search that finished inside the budget.
function hardMove(board: Board, player: Player, budgetMs: number): number {
  const deadline = performance.now() + budgetMs;
  const scratch = [...board];
  const candidates = rankedMoves(board, player).slice(0, BRANCHING);
  const first = candidates[0];
  if (first === undefined) throw new Error('no legal move');
  let best: number = first;
  for (let depth = 1; depth <= scratch.length; depth++) {
    try {
      let bestScore = -Infinity;
      let bestAtDepth = best;
      for (const cell of candidates) {
        scratch[cell] = player;
        const score = winningLine(scratch, cell, player)
          ? WIN + depth
          : -search(scratch, other(player), depth, -Infinity, -bestScore, deadline);
        scratch[cell] = null;
        if (score > bestScore) {
          bestScore = score;
          bestAtDepth = cell;
        }
      }
      best = bestAtDepth;
      if (bestScore >= WIN) break;
    } catch (error) {
      if (error instanceof Timeout) break;
      throw error;
    }
  }
  return best;
}

export function chooseMove(
  board: Board,
  player: Player,
  difficulty: Difficulty,
  random: Random = Math.random,
  hardBudgetMs: number = HARD_TIME_BUDGET_MS,
): number {
  const empty = emptyCells(board);
  if (empty.length === 0) throw new Error('no legal move: the board is full');

  const win = findWin(board, player);
  if (win !== undefined) return win;

  switch (difficulty) {
    case 'easy':
      return pick(empty, random);
    case 'medium': {
      const block = findWin(board, other(player));
      if (block !== undefined) return block;
      return pick(rankedMoves(board, player).slice(0, 3), random);
    }
    case 'hard': {
      const block = findWin(board, other(player));
      if (block !== undefined) return block;
      return hardMove(board, player, hardBudgetMs);
    }
  }
}

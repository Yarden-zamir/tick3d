// The computer of the Tesseract experiment. It follows the ideas of the classic computer (src/ai.ts) on the
// 4×4×4×4 board: take a win, block a win, look for a win by threats in a row, then a short alpha-beta search
// that ends at a time limit. 256 cells and 520 lines make a deep search too slow for a phone, so the
// search is narrow and the threat search does most of the work.
import { type Board, type Mark, type Player, LINES, emptyCells, linesThrough, other, threatCells, winningLine } from './rules.ts';

export const LEVELS = ['easy', 'hard'] as const;
export type Level = (typeof LEVELS)[number];
type Random = () => number;

// Line weights by the number of marks one player has in a line the other player does not block.
const LINE_WEIGHT = [0, 1, 12, 150, 0] as const;
const WIN = 1_000_000;
const STRONG_CELL_BONUS = 4;
const BRANCHING = 10;
const THREAT_DEPTH = 6;

class Timeout extends Error {}

function countLine(board: Board, line: readonly number[], player: Player): { mine: number; theirs: number } {
  let mine = 0;
  let theirs = 0;
  for (const c of line) {
    if (board[c] === player) mine++;
    else if (board[c] !== null) theirs++;
  }
  return { mine, theirs };
}

const isStrongCell = (cell: number) => linesThrough(cell).length === 15;

// How much a move helps `player`: lines it builds, lines of the opponent it blocks, and the cell itself.
function moveScore(board: Board, cell: number, player: Player, defense: number): number {
  let score = isStrongCell(cell) ? STRONG_CELL_BONUS : 0;
  for (const line of linesThrough(cell)) {
    const { mine, theirs } = countLine(board, line, player);
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3];
    if (mine === 0) score += LINE_WEIGHT[theirs as 0 | 1 | 2 | 3] * defense;
  }
  return score;
}

function scoredMoves(board: Board, player: Player, defense = 0.9): { cell: number; score: number }[] {
  return emptyCells(board)
    .map((cell) => ({ cell, score: moveScore(board, cell, player, defense) }))
    .sort((a, b) => b.score - a.score);
}

function evaluate(board: Board, player: Player): number {
  let score = 0;
  for (const line of LINES) {
    const { mine, theirs } = countLine(board, line, player);
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3];
    else if (mine === 0) score -= LINE_WEIGHT[theirs as 0 | 1 | 2 | 3];
  }
  return score;
}

function pick<T>(items: readonly T[], random: Random): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('cannot pick from an empty list');
  return item;
}

// A win by threats in a row: each move makes a line of three, the opponent must block it, until one move
// makes two winning cells at once. Returns the first move of that sequence. A block that makes a
// winning cell for the opponent ends the sequence.
export function forcedWin(board: Mark[], player: Player, depth: number, deadline: number): number | undefined {
  if (performance.now() > deadline) throw new Timeout();
  const opponent = other(player);
  if (threatCells(board, opponent).length > 0) return undefined;
  const tried = new Set<number>();
  for (const line of LINES) {
    const { mine, theirs } = countLine(board, line, player);
    if (mine !== 2 || theirs !== 0) continue;
    for (const cell of line) {
      if (board[cell] !== null || tried.has(cell)) continue;
      tried.add(cell);
      board[cell] = player;
      let wins = false;
      let block: number | undefined;
      try {
        const threats = threatCells(board, player);
        wins = threats.length >= 2;
        block = threats.length === 1 ? threats[0] : undefined;
        if (!wins && block !== undefined && depth > 1) {
          board[block] = opponent;
          if (threatCells(board, opponent).length === 0) wins = forcedWin(board, player, depth - 1, deadline) !== undefined;
        }
      } finally {
        if (block !== undefined) board[block] = null;
        board[cell] = null;
      }
      if (wins) return cell;
    }
  }
  return undefined;
}

function leafValue(board: Board, player: Player): number {
  if (threatCells(board, other(player)).length > 0) return -WIN / 2;
  if (threatCells(board, player).length >= 2) return WIN / 2;
  return evaluate(board, player);
}

// Negamax with alpha-beta pruning over the best-ranked moves only. The value is for `player`, who moves next.
function search(board: Mark[], player: Player, depth: number, alpha: number, beta: number, deadline: number): number {
  if (performance.now() > deadline) throw new Timeout();
  const moves = scoredMoves(board, player).slice(0, BRANCHING);
  if (moves.length === 0) return 0;
  for (const { cell } of moves) {
    board[cell] = player;
    const score = winningLine(board, cell, player)
      ? WIN + depth
      : depth <= 1
        ? leafValue(board, player)
        : -search(board, other(player), depth - 1, -beta, -alpha, deadline);
    board[cell] = null;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function hardMove(board: Board, player: Player, budgetMs: number, random: Random): number {
  const start = performance.now();
  const deadline = start + budgetMs;
  const scratch = [...board];
  const opponent = other(player);
  try {
    for (let depth = 1; depth <= THREAT_DEPTH; depth++) {
      const attack = forcedWin(scratch, player, depth, start + budgetMs * 0.2);
      if (attack !== undefined) return attack;
    }
  } catch (error) {
    if (!(error instanceof Timeout)) throw error;
  }

  const candidates = scoredMoves(board, player).slice(0, BRANCHING).map(({ cell }) => cell);
  // A move that leaves the opponent a forced win loses. Drop those while another move is safe.
  const safe = candidates.filter((cell) => {
    scratch[cell] = player;
    try {
      return forcedWin(scratch, opponent, THREAT_DEPTH, start + budgetMs * 0.5) === undefined;
    } catch (error) {
      if (error instanceof Timeout) return true;
      throw error;
    } finally {
      scratch[cell] = null;
    }
  });
  const moves = safe.length > 0 ? safe : candidates;
  const first = moves[0];
  if (first === undefined) throw new Error('no legal move');

  let scores = new Map<number, number>([[first, 0]]);
  for (let depth = 1; depth <= 4; depth++) {
    try {
      const atDepth = new Map<number, number>();
      const ordered = [...moves].sort((a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity));
      for (const cell of ordered) {
        scratch[cell] = player;
        const score = winningLine(scratch, cell, player) ? WIN + depth : -search(scratch, opponent, depth, -Infinity, Infinity, deadline);
        scratch[cell] = null;
        atDepth.set(cell, score);
      }
      scores = atDepth;
    } catch (error) {
      if (error instanceof Timeout) break;
      throw error;
    }
  }
  const best = Math.max(...scores.values());
  return pick([...scores].filter(([, score]) => score >= best - 5).map(([cell]) => cell), random);
}

// Easy: blocks most wins, then picks among the better cells with some chance, so it plays loosely.
function easyMove(board: Board, player: Player, random: Random): number {
  const block = threatCells(board, other(player));
  if (block.length > 0 && random() < 0.7) return pick(block, random);
  const moves = scoredMoves(board, player, 0.6).slice(0, 8);
  return pick(moves, random).cell;
}

export function chooseMove(board: Board, player: Player, level: Level, random: Random = Math.random, budgetMs = 700): number {
  const empty = emptyCells(board);
  if (empty.length === 0) throw new Error('no legal move: the board is full');
  const win = threatCells(board, player);
  if (win.length > 0) return pick(win, random);
  if (empty.length === board.length) return pick(empty.filter(isStrongCell), random);
  switch (level) {
    case 'easy':
      return easyMove(board, player, random);
    case 'hard': {
      const block = threatCells(board, other(player));
      if (block.length > 0) return pick(block, random);
      return hardMove(board, player, budgetMs, random);
    }
  }
}

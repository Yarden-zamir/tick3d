import { type Board, type Mark, type Player, emptyCells, LINES, linesThrough, other, winningLine } from './game.ts';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type Random = () => number;

// Line weights by the number of marks one player has in a line that the other player does not block.
const LINE_WEIGHT = [0, 1, 12, 150, 0] as const;
// A cell on 7 lines (the 8 corners and the 8 inner cells) is worth more than a cell on 4 lines.
const STRONG_CELL_BONUS = 3;
const WIN = 1_000_000;
// The hard search looks at the best few moves per position only. Raise this if the hard level
// misses tactics, but each step costs search depth inside the same time budget.
const BRANCHING = 10;
const HARD_TIME_BUDGET_MS = 600;
// The forced-win search follows at most this many threats in a row.
const THREAT_DEPTH = 8;

// How each level plays. A higher temperature gives more random, more human choices.
// A chance below 1 makes the level miss that idea now and then.
type Style = {
  blockChance: number;
  forkChance: number;
  forkBlockChance: number;
  temperature: number;
  // How much the level values blocking the opponent's lines, against building its own.
  defense: number;
  // Only the best few cells are candidates for the weighted choice.
  candidates: number;
};

const STYLES: Record<'easy' | 'medium', Style> = {
  easy: { blockChance: 0.5, forkChance: 0.2, forkBlockChance: 0, temperature: 14, candidates: 12, defense: 0.15 },
  medium: { blockChance: 1, forkChance: 0.15, forkBlockChance: 0.1, temperature: 10, candidates: 6, defense: 0.9 },
};

const isStrongCell = (cell: number) => linesThrough(cell).length === 7;

function countLine(board: Board, line: readonly number[], player: Player): { mine: number; theirs: number } {
  let mine = 0;
  let theirs = 0;
  for (const c of line) {
    if (board[c] === player) mine++;
    else if (board[c] !== null) theirs++;
  }
  return { mine, theirs };
}

// Every empty cell that completes a line of `player` now.
function winningCells(board: Board, player: Player): number[] {
  const cells = new Set<number>();
  for (const line of LINES) {
    const { mine, theirs } = countLine(board, line, player);
    if (mine !== 3 || theirs !== 0) continue;
    const empty = line.find((c) => board[c] === null);
    if (empty !== undefined) cells.add(empty);
  }
  return [...cells];
}

// The cell that completes a line of `player` now, if one exists.
export function findWin(board: Board, player: Player): number | undefined {
  return emptyCells(board).find((cell) => winningLine(board.with(cell, player), cell, player));
}

// Cells that give `player` two winning cells at once. The opponent can block only one of them.
export function forkCells(board: Board, player: Player): number[] {
  return emptyCells(board).filter((cell) => {
    const threats = new Set<number>();
    for (const line of linesThrough(cell)) {
      const { mine, theirs } = countLine(board, line, player);
      if (mine !== 2 || theirs !== 0) continue;
      for (const c of line) if (c !== cell && board[c] === null) threats.add(c);
    }
    return threats.size >= 2;
  });
}

// How much a move helps `player`: lines it builds, enemy lines it blocks, and the value of the cell.
export function moveScore(board: Board, cell: number, player: Player, defense = 0.9): number {
  let score = isStrongCell(cell) ? STRONG_CELL_BONUS : 0;
  for (const line of linesThrough(cell)) {
    const { mine, theirs } = countLine(board, line, player);
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3];
    if (mine === 0) score += LINE_WEIGHT[theirs as 0 | 1 | 2 | 3] * defense;
  }
  return score;
}

// Static value of a position for `player`: open lines for them minus open lines for the opponent.
export function evaluate(board: Board, player: Player): number {
  let score = 0;
  for (const line of LINES) {
    const { mine, theirs } = countLine(board, line, player);
    if (theirs === 0) score += LINE_WEIGHT[mine as 0 | 1 | 2 | 3 | 4];
    else if (mine === 0) score -= LINE_WEIGHT[theirs as 0 | 1 | 2 | 3 | 4];
  }
  return score;
}

function scoredMoves(board: Board, player: Player, defense?: number): { cell: number; score: number }[] {
  return emptyCells(board)
    .map((cell) => ({ cell, score: moveScore(board, cell, player, defense) }))
    .sort((a, b) => b.score - a.score);
}

const rankedMoves = (board: Board, player: Player) => scoredMoves(board, player).map(({ cell }) => cell);

function pick<T>(items: readonly T[], random: Random): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('cannot pick from an empty list');
  return item;
}

// Picks a cell with a chance that grows with its score: good cells come often, weaker ones sometimes.
function weightedPick(moves: readonly { cell: number; score: number }[], temperature: number, random: Random): number {
  const best = moves[0];
  if (best === undefined) throw new Error('cannot pick from an empty list');
  const weights = moves.map(({ score }) => Math.exp((score - best.score) / temperature));
  let target = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (const [i, weight] of weights.entries()) {
    target -= weight;
    if (target <= 0) return moves[i]?.cell ?? best.cell;
  }
  return moves.at(-1)?.cell ?? best.cell;
}

class Timeout extends Error {}

// A win by threats in a row: each move makes a line of three, so the opponent must block it,
// until one move makes two winning cells at once. Returns the first move of that sequence.
// It stops a sequence when a forced block gives the opponent a winning cell of their own.
function forcedWin(board: Mark[], player: Player, depth: number, deadline: number): number | undefined {
  if (performance.now() > deadline) throw new Timeout();
  const opponent = other(player);
  // A player who must block first has no free move for a threat.
  if (winningCells(board, opponent).length > 0) return undefined;
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
      // The marks of the sequence come off again, also when the time runs out inside it.
      try {
        const threats = winningCells(board, player);
        wins = threats.length >= 2;
        block = threats.length === 1 ? threats[0] : undefined;
        if (!wins && block !== undefined && depth > 1) {
          board[block] = opponent;
          if (winningCells(board, opponent).length === 0) wins = forcedWin(board, player, depth - 1, deadline) !== undefined;
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

// The value at the end of a search line, for `player`, who just moved. A winning cell for the opponent,
// who moves next, loses. Two winning cells for `player` win, because the opponent can block only one.
function leafValue(board: Board, player: Player): number {
  if (winningCells(board, other(player)).length > 0) return -WIN / 2;
  if (winningCells(board, player).length >= 2) return WIN / 2;
  return evaluate(board, player);
}

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
        ? leafValue(board, player)
        : -search(board, other(player), depth - 1, -beta, -alpha, deadline);
    board[cell] = null;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// Moves within this margin of the best search score count as equal, so the hard level varies its play.
// A wider margin varies more but costs strength: 14 scored 38% against the previous hard level at 600 ms.
// Measure again with a self-play match when the budget or the evaluation changes.
const NEAR_BEST = 1;

// The hard level: a forced win first, then iterative deepening. It keeps the scores of the deepest
// search that finished inside the budget, and picks among the moves that are about as good as the best.
// The threat searches get the first part of the budget, the alpha-beta search the rest.
function hardMove(board: Board, player: Player, budgetMs: number, random: Random): number {
  const start = performance.now();
  const deadline = start + budgetMs;
  const scratch = [...board];
  const opponent = other(player);
  try {
    // Short sequences first, so the computer takes the quickest forced win.
    for (let depth = 1; depth <= THREAT_DEPTH; depth++) {
      const attack = forcedWin(scratch, player, depth, start + budgetMs * 0.1);
      if (attack !== undefined) return attack;
    }
  } catch (error) {
    if (!(error instanceof Timeout)) throw error;
  }

  const candidates = rankedMoves(board, player).slice(0, BRANCHING);
  // A candidate that leaves the opponent a forced win loses. Drop those while another candidate is safe.
  const safe = candidates.filter((cell) => {
    scratch[cell] = player;
    try {
      return forcedWin(scratch, opponent, THREAT_DEPTH, start + budgetMs * 0.25) === undefined;
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
  for (let depth = 1; depth <= scratch.length; depth++) {
    try {
      const atDepth = new Map<number, number>();
      let bestScore = -Infinity;
      // The best moves of the last depth go first, so the narrow window cuts more of the search.
      const ordered = [...moves].sort((a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity));
      for (const cell of ordered) {
        scratch[cell] = player;
        // A move far below the best only needs to be known as worse, so the window stays narrow.
        const score = winningLine(scratch, cell, player)
          ? WIN + depth
          : -search(scratch, opponent, depth, -Infinity, -(bestScore - NEAR_BEST - 1), deadline);
        scratch[cell] = null;
        atDepth.set(cell, score);
        bestScore = Math.max(bestScore, score);
      }
      scores = atDepth;
      if (Math.max(...atDepth.values()) >= WIN) break;
    } catch (error) {
      if (error instanceof Timeout) break;
      throw error;
    }
  }
  const best = Math.max(...scores.values());
  const nearBest = [...scores].filter(([, score]) => score >= best - NEAR_BEST).map(([cell]) => cell);
  return pick(nearBest, random);
}

// Easy and medium: a few ideas in order of urgency, each taken with the chance of the level, then a weighted choice.
function styledMove(board: Board, player: Player, style: Style, random: Random): number {
  const opponent = other(player);
  const block = findWin(board, opponent);
  if (block !== undefined && random() < style.blockChance) return block;
  const forks = forkCells(board, player);
  if (block === undefined && forks.length > 0 && random() < style.forkChance) return pick(forks, random);
  const enemyForks = forkCells(board, opponent);
  if (block === undefined && enemyForks.length > 0 && random() < style.forkBlockChance) return pick(enemyForks, random);
  return weightedPick(scoredMoves(board, player, style.defense).slice(0, style.candidates), style.temperature, random);
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

  // Every level takes a win.
  const win = findWin(board, player);
  if (win !== undefined) return win;
  // The first move of a game goes to a random strong cell, so each game opens differently.
  // A reply to that move needs thought, so it goes through the level as usual.
  if (empty.length === board.length) return pick(empty.filter(isStrongCell), random);

  switch (difficulty) {
    case 'easy':
    case 'medium':
      return styledMove(board, player, STYLES[difficulty], random);
    case 'hard': {
      const block = findWin(board, other(player));
      if (block !== undefined) return block;
      return hardMove(board, player, hardBudgetMs, random);
    }
  }
}

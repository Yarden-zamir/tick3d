// Rules for 3D tic-tac-toe on a 4x4x4 cube (also known as Qubic).
// A cell is an index 0..63: layer * 16 + row * 4 + column.

export const SIZE = 4;
export const CELL_COUNT = SIZE ** 3;

export type Player = 'X' | 'O';
export type Mark = Player | null;
export type Board = readonly Mark[];
export type Line = readonly [number, number, number, number];
export type Coords = { layer: number; row: number; column: number };

export type Status =
  | { kind: 'playing' }
  | { kind: 'won'; winner: Player; line: Line }
  | { kind: 'draw' };

export type Game = {
  board: Board;
  turn: Player;
  first: Player;
  status: Status;
  moves: readonly number[];
};

export type MoveError = 'occupied' | 'game-over';
export type MoveResult = { ok: true; game: Game } | { ok: false; error: MoveError };

export const other = (player: Player): Player => (player === 'X' ? 'O' : 'X');

export function assertCell(cell: number): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
    throw new RangeError(`cell must be an integer in 0..${CELL_COUNT - 1}, got ${cell}`);
  }
}

export function toCell({ layer, row, column }: Coords): number {
  for (const value of [layer, row, column]) {
    if (!Number.isInteger(value) || value < 0 || value >= SIZE) {
      throw new RangeError(`coordinate out of range: ${layer},${row},${column}`);
    }
  }
  return layer * SIZE * SIZE + row * SIZE + column;
}

export function toCoords(cell: number): Coords {
  assertCell(cell);
  return {
    layer: Math.floor(cell / (SIZE * SIZE)),
    row: Math.floor(cell / SIZE) % SIZE,
    column: cell % SIZE,
  };
}

// Every straight line of 4 cells: 48 along an axis, 24 diagonals inside a plane, 4 through the cube.
function buildLines(): Line[] {
  const steps = [-1, 0, 1];
  const lines: Line[] = [];
  for (const dl of steps) {
    for (const dr of steps) {
      for (const dc of steps) {
        // Keep one of each pair of opposite directions: the first non-zero step is positive.
        const firstStep = dl !== 0 ? dl : dr !== 0 ? dr : dc;
        if (firstStep !== 1) continue;
        // A step of +1 starts at 0, a step of -1 starts at 3, a step of 0 starts anywhere.
        const starts = (step: number) => (step === 0 ? [0, 1, 2, 3] : step === 1 ? [0] : [SIZE - 1]);
        for (const layer of starts(dl)) {
          for (const row of starts(dr)) {
            for (const column of starts(dc)) {
              const at = (i: number) =>
                toCell({ layer: layer + dl * i, row: row + dr * i, column: column + dc * i });
              lines.push([at(0), at(1), at(2), at(3)]);
            }
          }
        }
      }
    }
  }
  return lines;
}

export const LINES: readonly Line[] = buildLines();

export const LINES_THROUGH: readonly (readonly Line[])[] = Array.from({ length: CELL_COUNT }, (_, cell) =>
  LINES.filter((line) => line.includes(cell)),
);

export function linesThrough(cell: number): readonly Line[] {
  const lines = LINES_THROUGH[cell];
  if (lines === undefined) throw new RangeError(`no lines for cell ${cell}`);
  return lines;
}

export function winningLine(board: Board, cell: number, player: Player): Line | undefined {
  return linesThrough(cell).find((line) => line.every((c) => board[c] === player));
}

export function emptyCells(board: Board): number[] {
  const cells: number[] = [];
  board.forEach((mark, cell) => {
    if (mark === null) cells.push(cell);
  });
  return cells;
}

export function newGame(first: Player = 'X'): Game {
  return {
    board: Array<Mark>(CELL_COUNT).fill(null),
    turn: first,
    first,
    status: { kind: 'playing' },
    moves: [],
  };
}

export function play(game: Game, cell: number): MoveResult {
  assertCell(cell);
  if (game.status.kind !== 'playing') return { ok: false, error: 'game-over' };
  if (game.board[cell] !== null) return { ok: false, error: 'occupied' };

  const board = game.board.with(cell, game.turn);
  const moves = [...game.moves, cell];
  const line = winningLine(board, cell, game.turn);
  const status: Status = line
    ? { kind: 'won', winner: game.turn, line }
    : moves.length === CELL_COUNT
      ? { kind: 'draw' }
      : { kind: 'playing' };
  return { ok: true, game: { ...game, board, moves, status, turn: other(game.turn) } };
}

// Replays all moves except the last `count`, so the result is always a reachable position.
export function undo(game: Game, count: number): Game {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`undo count must be >= 0, got ${count}`);
  let replay = newGame(game.first);
  for (const cell of game.moves.slice(0, Math.max(0, game.moves.length - count))) {
    const result = play(replay, cell);
    if (!result.ok) throw new Error(`move history is not valid: ${result.error} at cell ${cell}`);
    replay = result.game;
  }
  return replay;
}

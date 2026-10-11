// Rules for the Tesseract experiment: tic-tac-toe on a 4×4×4×4 board. Four in any straight line wins.
// A cell is an index 0..255: cube * 64 + layer * 16 + row * 4 + column. The cube is the fourth coordinate:
// the page shows one cube at a time, with the same layers, rows and columns as the classic board.
// The classic game (src/game.ts) does not use this file, so its records and protocol stay as they are.

export const SIZE = 4;
export const CUBE_CELLS = SIZE ** 3;
export const CELL_COUNT = SIZE ** 4;

export type Player = 'X' | 'O';
export type Mark = Player | null;
export type Board = readonly Mark[];
export type Line = readonly [number, number, number, number];
export type Coords = { cube: number; layer: number; row: number; column: number };

type Status = { kind: 'playing' } | { kind: 'won'; winner: Player; line: Line } | { kind: 'draw' };

export type Game = { board: Board; turn: Player; first: Player; status: Status; moves: readonly number[] };

type MoveResult = { ok: true; game: Game } | { ok: false; error: 'occupied' | 'game-over' };

export const other = (player: Player): Player => (player === 'X' ? 'O' : 'X');

const AXES = ['cube', 'layer', 'row', 'column'] as const;

function assertCell(cell: number): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
    throw new RangeError(`cell must be an integer in 0..${CELL_COUNT - 1}, got ${cell}`);
  }
}

export function toCell(coords: Coords): number {
  let cell = 0;
  for (const axis of AXES) {
    const value = coords[axis];
    if (!Number.isInteger(value) || value < 0 || value >= SIZE) throw new RangeError(`${axis} out of range: ${value}`);
    cell = cell * SIZE + value;
  }
  return cell;
}

export function toCoords(cell: number): Coords {
  assertCell(cell);
  return {
    cube: Math.floor(cell / CUBE_CELLS),
    layer: Math.floor(cell / (SIZE * SIZE)) % SIZE,
    row: Math.floor(cell / SIZE) % SIZE,
    column: cell % SIZE,
  };
}

// Every straight line of 4 cells. A direction steps each coordinate by -1, 0 or +1. Of each pair of
// opposite directions only the one whose first non-zero step is +1 counts. A step of 0 lets the line
// start at any value of that coordinate; +1 starts at 0 and -1 at 3. That makes (6⁴ − 4⁴) / 2 = 520 lines.
function buildLines(): Line[] {
  const steps = [-1, 0, 1];
  let directions: number[][] = [[]];
  for (const _ of AXES) directions = directions.flatMap((d) => steps.map((step) => [...d, step]));
  const lines: Line[] = [];
  for (const direction of directions) {
    if (direction.find((step) => step !== 0) !== 1) continue;
    const startsPerAxis = direction.map((step) => (step === 0 ? [0, 1, 2, 3] : step === 1 ? [0] : [SIZE - 1]));
    let starts: number[][] = [[]];
    for (const options of startsPerAxis) starts = starts.flatMap((start) => options.map((value) => [...start, value]));
    for (const start of starts) {
      const at = (i: number) => {
        const [cube = 0, layer = 0, row = 0, column = 0] = start.map((value, axis) => value + (direction[axis] ?? 0) * i);
        return toCell({ cube, layer, row, column });
      };
      lines.push([at(0), at(1), at(2), at(3)]);
    }
  }
  return lines;
}

export const LINES: readonly Line[] = buildLines();

const LINES_THROUGH: readonly (readonly Line[])[] = Array.from({ length: CELL_COUNT }, (_, cell) =>
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
  return { board: Array<Mark>(CELL_COUNT).fill(null), turn: first, first, status: { kind: 'playing' }, moves: [] };
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

// Replays a move list from an empty board. Throws if a move is not legal.
export function replay(moves: readonly number[], first: Player = 'X'): Game {
  let game = newGame(first);
  for (const cell of moves) {
    const result = play(game, cell);
    if (!result.ok) throw new Error(`move history is not valid: ${result.error} at cell ${cell}`);
    game = result.game;
  }
  return game;
}

// How many coordinates change along a line: 1 is along an axis, 4 runs through all four dimensions.
export function lineSpan(line: Line): 1 | 2 | 3 | 4 {
  const a = toCoords(line[0]);
  const b = toCoords(line[1]);
  return AXES.filter((axis) => a[axis] !== b[axis]).length as 1 | 2 | 3 | 4;
}

// Every empty cell that completes a line of `player` now, so the other player must take it or lose.
export function threatCells(board: Board, player: Player): number[] {
  const cells = new Set<number>();
  for (const line of LINES) {
    let mine = 0;
    let empty: number | undefined;
    for (const c of line) {
      if (board[c] === player) mine++;
      else if (board[c] === null) empty = c;
    }
    if (mine === 3 && empty !== undefined) cells.add(empty);
  }
  return [...cells];
}

// "cube layer row column", 1-based: "2341", "2 3 4 1" and "2,3,4,1" all work.
export function parseCoordinates(text: string): Coords | undefined {
  const parts = [...text].filter((char) => char !== ' ' && char !== ',');
  if (parts.length !== AXES.length) return undefined;
  const values = parts.map(Number);
  if (!values.every((value) => Number.isInteger(value) && value >= 1 && value <= SIZE)) return undefined;
  const [cube = 0, layer = 0, row = 0, column = 0] = values.map((value) => value - 1);
  return { cube, layer, row, column };
}

export const formatCoordinates = ({ cube, layer, row, column }: Coords): string =>
  `${cube + 1}${layer + 1}${row + 1}${column + 1}`;

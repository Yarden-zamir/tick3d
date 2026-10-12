// The game of the smart-memory ad (issue #130): the self-play of src/ai.ts with seed 2206, Medium against Medium.
// X plays cell 30 (keypad 2 4 3) for a double threat, O blocks one threat, and X wins corner to corner. Hard is
// not used: its search stops on a time budget (src/ai.ts hardMove), so its self-play differs between machines.
// game.test.ts plays the seed again and checks every fact here against the game code.
import { type Coords, type Game, type Line, replay, toCoords } from '../../../src/game.ts';
import type { Difficulty } from '../../../src/ai.ts';

export const SEED = 2206;
export const LEVELS: Readonly<Record<'X' | 'O', Difficulty>> = { X: 'medium', O: 'medium' };
// The cells of the moves in order, X first. Kept here, so a render does not run the self-play.
export const MOVES: readonly number[] = [42, 0, 22, 62, 60, 41, 15, 12, 26, 37, 30, 18, 45];
// The move that makes the double threat, and the two cells where X then wins.
export const FORK_MOVE = 10;
export const THREAT_CELLS: readonly [number, number] = [18, 45];
// The two lines of the double threat: a column of layer 2 through cell 18, and the corner-to-corner line through 45.
export const THREAT_LINES: readonly [Line, Line] = [
  [18, 22, 26, 30],
  [15, 30, 45, 60],
];
export const WIN_LINE: Line = [15, 30, 45, 60];

export const GAME: Game = replay(MOVES);
export const playerOf = (move: number): 'X' | 'O' => (move % 2 === 0 ? 'X' : 'O');

// The digits that the keypad shows for a cell: layer, row and column from 1 (src/page/keypad.ts).
export function digitsOf(cell: number): readonly [number, number, number] {
  const { layer, row, column }: Coords = toCoords(cell);
  return [layer + 1, row + 1, column + 1];
}

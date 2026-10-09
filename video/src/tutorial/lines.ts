// The winning lines of the game (LINES of src/game.ts), sorted into the six kinds that the tutorial shows, and
// the strong cells: the cells on the most lines. Everything here comes from the cell coordinates.
import { CELL_COUNT, LINES, type Line, linesThrough, toCoords } from '../../../src/game.ts';

// In the order of the tutorial. A row runs along the columns of one row of a layer, a column along the rows of
// one column, a pillar straight up. A layer diagonal stays in its layer, a climbing diagonal climbs one layer per
// cell on a vertical plane, and a space diagonal runs corner to corner through the cube.
export const KINDS = ['row', 'column', 'pillar', 'layer-diagonal', 'climbing-diagonal', 'space-diagonal'] as const;
export type Kind = (typeof KINDS)[number];

// The kind of a line, from the coordinates that change between its first two cells.
export function kindOf(line: Line): Kind {
  const a = toCoords(line[0]);
  const b = toCoords(line[1]);
  const layer = a.layer !== b.layer;
  const row = a.row !== b.row;
  const column = a.column !== b.column;
  if (layer && row && column) return 'space-diagonal';
  if (layer) return row || column ? 'climbing-diagonal' : 'pillar';
  if (row && column) return 'layer-diagonal';
  if (row) return 'column';
  if (column) return 'row';
  throw new RangeError(`not a line: ${line.join('-')}`);
}

export const linesOf = (kind: Kind): readonly Line[] => LINES.filter((line) => kindOf(line) === kind);

const CELLS = Array.from({ length: CELL_COUNT }, (_, cell) => cell);
// The most lines through one cell.
export const MOST_LINES = Math.max(...CELLS.map((cell) => linesThrough(cell).length));
// The strong cells, on MOST_LINES lines each: the 8 corners and the 8 cells of the core.
export const STRONG_CELLS: readonly number[] = CELLS.filter((cell) => linesThrough(cell).length === MOST_LINES);

// A corner: every coordinate is 0 or 3. The core: every coordinate is 1 or 2.
const allIn = (cell: number, values: readonly number[]) => Object.values(toCoords(cell)).every((value) => values.includes(value));
export const isCorner = (cell: number): boolean => allIn(cell, [0, 3]);
export const isCore = (cell: number): boolean => allIn(cell, [1, 2]);

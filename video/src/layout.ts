// The sizes of the tower in world units. One cell is 1 unit wide.
import { Vector3 } from 'three';
import { SIZE, toCoords } from '../../src/game.ts';

export const CELL = 1;
const GAP = 0.12;
const PITCH = CELL + GAP;
// The height between two boards of the tower.
export const LAYER_GAP = 1.4;
export const TILE_HEIGHT = 0.14;
// The thick outline of the neo-brutalist look: about 3 px of a 50 px cell, as `--border` in src/style.css.
export const OUTLINE = 0.04;
// The X and the O fill this share of a cell, and stand this high.
export const PIECE = 0.78;
export const PIECE_HEIGHT = 0.16;

const middle = (SIZE - 1) / 2;
export const TOWER_CENTER = new Vector3(0, middle * LAYER_GAP, 0);

// The centre of a cell's board square, at the height of the top of its tile: the board plane of its layer.
export function cellBase(cell: number): Vector3 {
  const { layer, row, column } = toCoords(cell);
  return new Vector3((column - middle) * PITCH, layer * LAYER_GAP + TILE_HEIGHT / 2, (row - middle) * PITCH);
}

// The middle of a piece on a cell: where the lines and the beam pass.
export const cellCenter = (cell: number): Vector3 => cellBase(cell).add(new Vector3(0, PIECE_HEIGHT / 2, 0));

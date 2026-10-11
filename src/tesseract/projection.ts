// The 4D view of the Tesseract experiment: each cell is a point in 4D, turned in the plane of the column
// and the cube, then drawn with perspective twice, 4D to 3D and 3D to the screen. Unturned, the four
// cubes sit one inside the other: cube 1 smallest, cube 4 largest, the usual picture of a tesseract.
// A perspective projection keeps straight lines straight, so every winning line is a straight line on screen.
import { CELL_COUNT, SIZE, toCoords } from './rules.ts';

export type Camera = {
  // The turn in the plane of the column and the cube (radians). Animating it turns the cubes through each other.
  turn4: number;
  // The 3D orbit: around the vertical, then up and down.
  yaw: number;
  pitch: number;
};

export const DEFAULT_CAMERA: Camera = { turn4: 0, yaw: 0.55, pitch: 0.35 };

// A point on the screen, in units of one cell step at the middle of the board, y up.
// `depth` grows towards the viewer and `scale` is how much perspective enlarged the point.
export type Projected = { x: number; y: number; depth: number; scale: number };

const CENTER = (SIZE - 1) / 2;
// Distances of the eyes from the middle. A point lies at most 3 from the middle, so both stay in front.
const EYE_4D = 6;
const EYE_3D = 9;

// A cell as a 4D point around the middle of the board: x the column, y the layer (up), z the row, w the cube.
function pointOf(cell: number): [number, number, number, number] {
  const { cube, layer, row, column } = toCoords(cell);
  return [column - CENTER, layer - CENTER, row - CENTER, cube - CENTER];
}

export function project(cell: number, camera: Camera): Projected {
  let [x, y, z, w] = pointOf(cell);
  const c4 = Math.cos(camera.turn4);
  const s4 = Math.sin(camera.turn4);
  [x, w] = [x * c4 - w * s4, x * s4 + w * c4];
  const k4 = EYE_4D / (EYE_4D - w);
  x *= k4;
  y *= k4;
  z *= k4;
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  [x, z] = [x * cy - z * sy, x * sy + z * cy];
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp];
  const k3 = EYE_3D / (EYE_3D - z);
  return { x: x * k3, y: y * k3, depth: z, scale: k4 * k3 };
}

export const projectAll = (camera: Camera): Projected[] => Array.from({ length: CELL_COUNT }, (_, cell) => project(cell, camera));

// The cell drawn nearest to (x, y) within `radius`, the frontmost on a tie. Units as in Projected.
export function pickCell(points: readonly Projected[], x: number, y: number, radius: number): number | undefined {
  let best: number | undefined;
  let bestScore = Infinity;
  points.forEach((point, cell) => {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance > radius * point.scale) return;
    // A point in front wins over one just behind it: depth counts a little.
    const score = distance - point.depth * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = cell;
    }
  });
  return best;
}

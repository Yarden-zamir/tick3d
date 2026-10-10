// The shapes of the X and the O as flat outlines, in world units, centred on the cell.
import { Path, Shape, Vector2 } from 'three';
import { PIECE } from './layout.ts';

// The O of `.o .piece::before` in src/style.css: a ring inset 4 % in the piece, 0.13 cell thick.
const RING_INSET = 0.04;
const RING_WIDTH = 0.13;

// Moves every edge of a simple polygon outwards by `distance`, with mitred corners: the thick outline of the X.
function offsetPolygon(points: readonly Vector2[], distance: number): Vector2[] {
  // The sign of the area tells the winding, so "outwards" works for both windings.
  let area = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    if (q !== undefined) area += p.x * q.y - q.x * p.y;
  });
  const outwards = area > 0 ? 1 : -1;
  const normal = (a: Vector2, b: Vector2) => new Vector2(b.y - a.y, a.x - b.x).normalize().multiplyScalar(outwards);
  return points.map((point, i) => {
    const before = points[(i - 1 + points.length) % points.length];
    const after = points[(i + 1) % points.length];
    if (before === undefined || after === undefined) throw new RangeError('a polygon needs 3 points');
    const n1 = normal(before, point);
    const n2 = normal(point, after);
    const miter = n1.clone().add(n2).normalize();
    return point.clone().addScaledVector(miter, distance / miter.dot(n1));
  });
}

// The X from its clip-path corners (0 to 1, y down), `grow` units wider on every side.
export function xShape(corners: readonly (readonly [number, number])[], grow = 0): Shape {
  const points = corners.map(([x, y]) => new Vector2((x - 0.5) * PIECE, (0.5 - y) * PIECE));
  return new Shape(grow === 0 ? points : offsetPolygon(points, grow));
}

// The O ring, `grow` units wider on both edges.
export function oShape(grow = 0): Shape {
  const outer = PIECE * (0.5 - RING_INSET);
  const inner = outer - RING_WIDTH;
  const shape = new Shape().absarc(0, 0, outer + grow, 0, Math.PI * 2, false);
  shape.holes.push(new Path().absarc(0, 0, inner - grow, 0, Math.PI * 2, true));
  return shape;
}

import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA, type Camera, pickCell, project, projectAll } from './projection.ts';
import { LINES, toCell } from './rules.ts';

const at = (cube: number, layer: number, row: number, column: number) => toCell({ cube, layer, row, column });

describe('the 4D projection', () => {
  it('nests the cubes when unturned: cube 1 inside, cube 4 outside', () => {
    const camera: Camera = { turn4: 0, yaw: 0, pitch: 0 };
    const spread = (cube: number) => project(at(cube, 0, 0, 3), camera).x - project(at(cube, 0, 0, 0), camera).x;
    expect(spread(0)).toBeLessThan(spread(1));
    expect(spread(1)).toBeLessThan(spread(2));
    expect(spread(2)).toBeLessThan(spread(3));
  });

  it('turns the cubes through each other: a half turn swaps the inside and the outside', () => {
    const half: Camera = { turn4: Math.PI, yaw: 0, pitch: 0 };
    const spread = (cube: number) => Math.abs(project(at(cube, 0, 0, 3), half).x - project(at(cube, 0, 0, 0), half).x);
    expect(spread(0)).toBeGreaterThan(spread(3));
  });

  // The reason the view works: a winning line, in any of the 520 directions, is a straight line on screen.
  it('draws every line as a straight line, at any turn', () => {
    const cameras: Camera[] = [DEFAULT_CAMERA, { turn4: 0.7, yaw: -1.2, pitch: 0.9 }, { turn4: 2.4, yaw: 2, pitch: -0.4 }];
    for (const camera of cameras) {
      for (const line of LINES) {
        const [a, b, c, d] = line.map((cell) => project(cell, camera));
        if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error('short line');
        const length = Math.hypot(d.x - a.x, d.y - a.y);
        for (const p of [b, c]) {
          // The distance of p from the line through a and d.
          const off = Math.abs((d.x - a.x) * (p.y - a.y) - (d.y - a.y) * (p.x - a.x)) / Math.max(length, 1e-9);
          expect(off).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('picks the cell under the pointer, and nothing far from every cell', () => {
    const points = projectAll(DEFAULT_CAMERA);
    const target = at(3, 3, 0, 3);
    const point = points[target];
    if (point === undefined) throw new Error('no point');
    expect(pickCell(points, point.x, point.y, 0.2)).toBe(target);
    expect(pickCell(points, 100, 100, 0.2)).toBeUndefined();
  });
});

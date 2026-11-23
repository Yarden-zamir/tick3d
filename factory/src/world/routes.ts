// Routing on the factory floor, shared by belts, pipes and tubes. Inside a zone a route drops from its
// machine into the aisle below its row, runs along the aisles, and enters its target from the east.
// Between zones it runs to the zone hub, out onto the road south of its row, through the gaps between
// plots, and up into the other hub.

import type * as THREE from 'three';
import type { ZoneId } from '../../scan/model.ts';
import { CELL, GAP_X, GAP_Z, type Layout, type Plot } from '../layout.ts';

export type P2 = { x: number; z: number };
export type LaneClass = 'aisle' | 'road';
export interface RoutePart {
  cls: LaneClass;
  points: P2[];
}

export interface Router {
  /** The road south of each row, north to south. */
  rowRoad: number[];
  /** The x of each gap that crosses a row (between plots, and past both ends). */
  rowGaps: number[][];
  rowOf: Map<ZoneId, number>;
  /** The route between two placed entities, or undefined when one is not placed. */
  route(from: string, to: string): RoutePart[] | undefined;
  /** Hub to hub over the roads. */
  roadRoute(a: ZoneId, b: ZoneId): P2[];
  bestGap(row: number, from: number, to: number): number;
}

export const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

/** Drops repeated points and the middle of straight runs, so every remaining point is a turn. */
export function simplify(points: P2[]): P2[] {
  const out: P2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && near(last.x, point.x) && near(last.z, point.z)) continue;
    const before = out[out.length - 2];
    if (before && last && ((near(before.x, last.x) && near(last.x, point.x)) || (near(before.z, last.z) && near(last.z, point.z)))) {
      const forward = (last.x - before.x) * (point.x - last.x) + (last.z - before.z) * (point.z - last.z) > 0;
      if (forward) out.pop();
    }
    out.push(point);
  }
  return out;
}

const direction = (a: P2, b: P2): P2 => ({ x: Math.sign(b.x - a.x), z: Math.sign(b.z - a.z) });
/** Keep right: the lane offset for travel along d. */
const keepRight = (d: P2, offset: number): P2 => ({ x: -d.z * offset, z: d.x * offset });

/** The lane points of a centre line: each corner moves right by the lane offset of both its legs. */
export function offsetPath(points: P2[], offset: number): P2[] {
  const out: P2[] = [];
  const count = points.length;
  for (let index = 0; index < count; index += 1) {
    const point = points[index] as P2;
    const before = index > 0 ? direction(points[index - 1] as P2, point) : null;
    const after = index < count - 1 ? direction(point, points[index + 1] as P2) : null;
    if (before && after && near(before.x, -after.x) && near(before.z, -after.z)) {
      // A U-turn: leave on one lane, come back on the other.
      const a = keepRight(before, offset);
      const b = keepRight(after, offset);
      out.push({ x: point.x + a.x, z: point.z + a.z }, { x: point.x + b.x, z: point.z + b.z });
      continue;
    }
    const a = before ? keepRight(before, offset) : { x: 0, z: 0 };
    const b = after ? keepRight(after, offset) : { x: 0, z: 0 };
    out.push({ x: point.x + a.x + b.x, z: point.z + a.z + b.z });
  }
  return out;
}

export function createRouter(layout: Layout, hubs: Map<ZoneId, THREE.Vector3>): Router {
  const rowOf = new Map<ZoneId, number>();
  const rowRoad: number[] = [];
  const rowGaps: number[][] = [];
  const byRow = new Map<number, Plot[]>();
  for (const plot of layout.plots.values()) {
    const key = Math.round(plot.minZ * 100);
    byRow.set(key, [...(byRow.get(key) ?? []), plot]);
  }
  [...byRow.keys()]
    .sort((a, b) => a - b)
    .forEach((key, row) => {
      const plots = (byRow.get(key) ?? []).sort((a, b) => a.minX - b.minX);
      for (const plot of plots) rowOf.set(plot.zone, row);
      rowRoad.push(Math.max(...plots.map((plot) => plot.maxZ)) + GAP_Z / 2);
      const first = plots[0];
      const last = plots[plots.length - 1];
      const gaps = first && last ? [first.minX - GAP_X / 2, last.maxX + GAP_X / 2] : [];
      for (let index = 1; index < plots.length; index += 1) {
        const a = plots[index - 1];
        const b = plots[index];
        if (a && b) gaps.push((a.maxX + b.minX) / 2);
      }
      rowGaps.push(gaps);
    });

  const bestGap = (row: number, from: number, to: number): number => {
    let best = from;
    let cost = Infinity;
    for (const gap of rowGaps[row] ?? []) {
      const value = Math.abs(from - gap) + Math.abs(gap - to);
      if (value < cost) {
        cost = value;
        best = gap;
      }
    }
    return best;
  };

  const roadRoute = (a: ZoneId, b: ZoneId): P2[] => {
    const hubA = hubs.get(a);
    const hubB = hubs.get(b);
    if (!hubA || !hubB) return [];
    const rowA = rowOf.get(a) ?? 0;
    const rowB = rowOf.get(b) ?? 0;
    const points: P2[] = [{ x: hubA.x, z: hubA.z }, { x: hubA.x, z: rowRoad[rowA] ?? hubA.z }];
    let x = hubA.x;
    if (rowB > rowA) {
      for (let row = rowA + 1; row <= rowB; row += 1) {
        x = bestGap(row, x, hubB.x);
        points.push({ x, z: rowRoad[row - 1] ?? 0 }, { x, z: rowRoad[row] ?? 0 });
      }
    } else {
      for (let row = rowA; row > rowB; row -= 1) {
        x = bestGap(row, x, hubB.x);
        points.push({ x, z: rowRoad[row] ?? 0 }, { x, z: rowRoad[row - 1] ?? 0 });
      }
    }
    points.push({ x: hubB.x, z: rowRoad[rowB] ?? hubB.z }, { x: hubB.x, z: hubB.z });
    return points;
  };

  const half = CELL / 2;
  // Down into the aisle below the machine, then along it.
  const toAisle = (x: number, z: number, aisleX: number): P2[] => [
    { x, z },
    { x, z: z + half },
    { x: aisleX, z: z + half },
  ];

  return {
    rowRoad,
    rowGaps,
    rowOf,
    bestGap,
    roadRoute,
    route(fromId, toId) {
      const from = layout.places.get(fromId);
      const to = layout.places.get(toId);
      if (!from || !to) return undefined;
      if (from.entity.zone === to.entity.zone) {
        return [{ cls: 'aisle', points: [...toAisle(from.x, from.z, to.x + half), { x: to.x + half, z: to.z }, { x: to.x, z: to.z }] }];
      }
      const hubA = hubs.get(from.entity.zone);
      const hubB = hubs.get(to.entity.zone);
      if (!hubA || !hubB) return undefined;
      return [
        { cls: 'aisle', points: [...toAisle(from.x, from.z, hubA.x), { x: hubA.x, z: hubA.z }] },
        { cls: 'road', points: roadRoute(from.entity.zone, to.entity.zone) },
        // From the hub along the walkway, then up the aisle east of the target.
        { cls: 'aisle', points: [{ x: hubB.x, z: hubB.z }, { x: to.x + half, z: hubB.z }, { x: to.x + half, z: to.z }, { x: to.x, z: to.z }] },
      ];
    },
  };
}

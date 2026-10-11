// Where everything stands. Each zone is a concrete plot with a grid of cells, one machine per cell.
// Plots line up in rows (lore.ts gives the row of each zone), with wide roads between them for the
// overhead trunk belts. Unit tests stand inside the cell of the file they test.

import type { Entity, FactoryModel, ZoneId } from '../scan/model.ts';
import { ZONES, ZONE_ORDER } from './lore.ts';

export const CELL = 5;
const MARGIN = 3;
const FRONT = 6; // the strip in front of the cells: the hub and the zone sign
const GAP_X = 16;
const GAP_Z = 20;

export interface Plot {
  zone: ZoneId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  hub: { x: number; z: number };
  sign: { x: number; z: number };
  entities: Entity[];
}

export interface Place {
  entity: Entity;
  x: number;
  z: number;
  /** The machine height. */
  h: number;
  /** The machine footprint (half width). */
  r: number;
  /** For a unit test: the file whose cell it shares. */
  host?: string;
}

export interface Layout {
  plots: Map<ZoneId, Plot>;
  places: Map<string, Place>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function heightOf(entity: Entity): number {
  const lines = entity.lines ?? 0;
  const data = entity.data ?? {};
  switch (entity.kind) {
    case 'module':
    case 'script':
      return clamp(0.9 + Math.sqrt(lines) / 3.2, 1, 8);
    case 'style':
      return clamp(1.1 + Math.sqrt(lines) / 5, 1.2, 5.5);
    case 'test':
      return 1.6;
    case 'spec':
      return 0.6;
    case 'page':
      return 2.6;
    case 'config':
      return clamp(1.2 + Math.min(lines, 600) / 200, 1.2, 4.2);
    case 'doc':
      return 2;
    case 'asset':
      return 0.9;
    case 'route':
      return 2.2;
    case 'table':
      return 2.4 + (Array.isArray(data.columns) ? data.columns.length : 3) * 0.5;
    case 'volume':
      return 3.4;
    case 'workflow':
      return 3.4 + (Array.isArray(data.triggers) ? data.triggers.length : 1) * 0.6;
    case 'job':
      return clamp(1.3 + (Array.isArray(data.steps) ? data.steps.length : 0) * 0.28, 1.3, 6.5);
    case 'stage':
      return 2.6;
    case 'service':
      return 2.8;
    case 'dep':
      return data.runtime === true ? 1.6 : 1.1;
    case 'hub':
      return 1.4;
  }
}

function sortKey(entity: Entity, index: number): string {
  const n = String(index).padStart(5, '0');
  switch (entity.kind) {
    case 'job':
    case 'service':
      return `${entity.file ?? ''}\u0001${n}`;
    case 'stage':
      return `Dockerfile\u0001${n}`;
    case 'route':
      return `~route${n}`;
    case 'volume':
      return `!volume${n}`;
    case 'table':
      return `~table${n}`;
    case 'dep':
      return `~~dep${entity.data?.runtime === true ? 0 : 1}${entity.label}`;
    default:
      return entity.id;
  }
}

export function computeLayout(model: FactoryModel): Layout {
  const byZone = new Map<ZoneId, Entity[]>();
  const tests: Entity[] = [];
  model.entities.forEach((entity, index) => {
    if (entity.kind === 'test' && entity.testOf) {
      tests.push(entity);
      return;
    }
    (entity as Entity & { _key?: string })._key = sortKey(entity, index);
    const list = byZone.get(entity.zone) ?? [];
    list.push(entity);
    byZone.set(entity.zone, list);
  });

  const plots = new Map<ZoneId, Plot>();
  const rows = new Map<number, ZoneId[]>();
  for (const zone of ZONE_ORDER) {
    const list = (byZone.get(zone) ?? []).sort((a, b) => {
      const ka = (a as Entity & { _key?: string })._key ?? a.id;
      const kb = (b as Entity & { _key?: string })._key ?? b.id;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const count = Math.max(list.length, 1);
    const cols = Math.max(3, Math.ceil(Math.sqrt(count * 1.6)));
    const rowCount = Math.max(1, Math.ceil(count / cols));
    plots.set(zone, {
      zone,
      minX: 0,
      maxX: cols * CELL + MARGIN * 2,
      minZ: 0,
      maxZ: rowCount * CELL + MARGIN * 2 + FRONT,
      cols,
      rows: rowCount,
      hub: { x: 0, z: 0 },
      sign: { x: 0, z: 0 },
      entities: list,
    });
    const row = ZONES[zone].row;
    rows.set(row, [...(rows.get(row) ?? []), zone]);
  }

  // Rows run west to east, centered, from north (row 0) to south.
  let z = 0;
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const zones = rows.get(row) ?? [];
    const widths = zones.map((zone) => plots.get(zone)?.maxX ?? 0);
    const total = widths.reduce((sum, width) => sum + width, 0) + GAP_X * (zones.length - 1);
    let x = -total / 2;
    let depth = 0;
    for (const zone of zones) {
      const plot = plots.get(zone);
      if (!plot) continue;
      const width = plot.maxX;
      const deep = plot.maxZ;
      plot.minX = x;
      plot.maxX = x + width;
      plot.minZ = z;
      plot.maxZ = z + deep;
      const front = z + MARGIN + plot.rows * CELL;
      plot.hub = { x: x + MARGIN + Math.round(plot.cols / 2) * CELL, z: front + 1.6 };
      plot.sign = { x: x + MARGIN + 3.5, z: plot.maxZ - 1.4 };
      x += width + GAP_X;
      depth = Math.max(depth, deep);
    }
    z += depth + GAP_Z;
  }

  // Center the whole map on the origin.
  const all = [...plots.values()];
  const bounds = {
    minX: Math.min(...all.map((plot) => plot.minX)),
    maxX: Math.max(...all.map((plot) => plot.maxX)),
    minZ: Math.min(...all.map((plot) => plot.minZ)),
    maxZ: Math.max(...all.map((plot) => plot.maxZ)),
  };
  const shiftZ = -(bounds.minZ + bounds.maxZ) / 2;
  for (const plot of all) {
    plot.minZ += shiftZ;
    plot.maxZ += shiftZ;
    plot.hub.z += shiftZ;
    plot.sign.z += shiftZ;
  }
  bounds.minZ += shiftZ;
  bounds.maxZ += shiftZ;

  const places = new Map<string, Place>();
  for (const plot of all) {
    plot.entities.forEach((entity, index) => {
      const col = index % plot.cols;
      const row = Math.floor(index / plot.cols);
      places.set(entity.id, {
        entity,
        x: plot.minX + MARGIN + CELL / 2 + col * CELL,
        z: plot.minZ + MARGIN + CELL / 2 + row * CELL,
        h: heightOf(entity),
        r: entity.kind === 'table' || entity.kind === 'volume' ? 1.5 : 1.25,
      });
    });
  }
  for (const test of tests) {
    const host = places.get(test.testOf ?? '');
    if (!host) continue;
    const siblings = host.entity.tests ?? [];
    const slot = Math.max(0, siblings.indexOf(test.id));
    places.set(test.id, { entity: test, x: host.x - 1.75, z: host.z - 1.2 + slot * 0.9, h: heightOf(test), r: 0.45, host: host.entity.id });
  }
  return { plots, places, bounds };
}

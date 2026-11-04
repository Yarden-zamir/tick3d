// Zone buildings. Every zone gets a building in a style that says what the zone does: a timber yard
// where packages arrive, a brick forge for the rules engine, a steel-and-glass hall for the API, a
// concrete bunker for the data, a concert hall for sound, a sealed dome for the Worker's own thread,
// and so on. Walls and floors are static; roofs lift away when you look inside (main.ts animates it).

import * as THREE from 'three';
import type { ZoneId } from '../../scan/model.ts';
import { CELL, type Plot } from '../layout.ts';
import { C, CYL, DOME, GABLE, Merger, SPHERE, TOOTH, VAULT } from './kit.ts';
import type { Post } from './machines.ts';

export interface StyleContext {
  plot: Plot;
  zone: THREE.Color;
  roofY: number;
  /** Floor, walls and props that never move. */
  m: Merger;
  /** Parts that glow (fire, signal lights). */
  lit: Merger;
  /** Roof parts that lift away when you look inside. */
  roof: Merger;
  /** Roof glass, lifted with the roof. */
  glass: Merger;
  posts: Post[];
  solids: THREE.Box3[];
}

interface Style {
  name: string;
  /** Why the zone looks like this. */
  meaning: string;
  build(ctx: StyleContext): void;
}

// Helpers. A plot has its cells at the north, a front strip at the south (hub and sign), and a door
// in the south side at the hub, where the belts leave for the road.
const frame = (plot: Plot) => {
  const cx = (plot.minX + plot.maxX) / 2;
  const cz = (plot.minZ + plot.maxZ) / 2;
  const width = plot.maxX - plot.minX;
  const depth = plot.maxZ - plot.minZ;
  const roofZ0 = plot.minZ + 1.5;
  const roofDepth = plot.rows * CELL + 3;
  return { cx, cz, width, depth, roofZ0, roofDepth, roofCz: roofZ0 + roofDepth / 2 };
};

function floor(ctx: StyleContext, color: string): void {
  const { cx, cz, width, depth } = frame(ctx.plot);
  ctx.m.block(C(color), cx, -0.2, cz, width, 0.22, depth);
  // A thin painted border in the zone color, so every zone keeps its color at a glance.
  const edge = 0.35;
  const { plot } = ctx;
  ctx.m.block(ctx.zone, cx, 0.02, plot.minZ + edge / 2, width, 0.04, edge);
  ctx.m.block(ctx.zone, cx, 0.02, plot.maxZ - edge / 2, width, 0.04, edge);
  ctx.m.block(ctx.zone, plot.minX + edge / 2, 0.02, cz, edge, 0.04, depth);
  ctx.m.block(ctx.zone, plot.maxX - edge / 2, 0.02, cz, edge, 0.04, depth);
}

function solid(ctx: StyleContext, x0: number, x1: number, z0: number, z1: number, h: number): void {
  ctx.solids.push(new THREE.Box3(new THREE.Vector3(Math.min(x0, x1), 0, Math.min(z0, z1)), new THREE.Vector3(Math.max(x0, x1), h, Math.max(z0, z1))));
}

/** Walls around the plot, with a door at the hub in the south wall. */
function walls(ctx: StyleContext, color: string, h: number, thick = 0.3, trim?: string): void {
  const { plot } = ctx;
  const wall = C(color);
  const inset = 0.5;
  const x0 = plot.minX + inset;
  const x1 = plot.maxX - inset;
  const z0 = plot.minZ + inset;
  const z1 = plot.maxZ - inset;
  const door = { a: plot.hub.x - 4, b: plot.hub.x + 4 };
  const run = (ax: number, az: number, bx: number, bz: number): void => {
    const w = Math.abs(bx - ax) || thick;
    const d = Math.abs(bz - az) || thick;
    ctx.m.block(wall, (ax + bx) / 2, 0, (az + bz) / 2, w, h, d);
    if (trim) ctx.m.block(C(trim), (ax + bx) / 2, h, (az + bz) / 2, w + 0.1, 0.18, d + 0.1);
    solid(ctx, ax - (w === thick ? thick / 2 : 0), bx + (w === thick ? thick / 2 : 0), az - (d === thick ? thick / 2 : 0), bz + (d === thick ? thick / 2 : 0), h);
  };
  run(x0, z0, x1, z0);
  run(x0, z0, x0, z1);
  run(x1, z0, x1, z1);
  run(x0, z1, door.a, z1);
  run(door.b, z1, x1, z1);
}

function column(ctx: StyleContext, color: THREE.Color, x: number, z: number, h: number, r = 0.18): void {
  ctx.m.block(color, x, 0, z, r * 2, h, r * 2);
  ctx.posts.push({ x, z, r: r + 0.05, h });
}

/** Columns along both long sides of the covered area, every two cells. */
function columns(ctx: StyleContext, color: string, h: number): void {
  const { plot } = ctx;
  const { roofZ0, roofDepth } = frame(plot);
  for (let x = plot.minX + 1; x <= plot.maxX - 0.9; x += CELL * 2) {
    column(ctx, C(color), x, roofZ0, h);
    column(ctx, C(color), x, roofZ0 + roofDepth, h);
  }
  column(ctx, C(color), plot.maxX - 1, roofZ0, h);
  column(ctx, C(color), plot.maxX - 1, roofZ0 + roofDepth, h);
}

function gable(target: Merger, color: THREE.Color, cx: number, y: number, cz: number, length: number, width: number, height: number): void {
  target.add(GABLE, color, cx, y, cz, length, height, width);
}

function sawtooth(ctx: StyleContext, color: string, glass: string, height: number): void {
  const { cx, width, roofZ0, roofDepth } = frame(ctx.plot);
  const teeth = Math.max(1, Math.round(roofDepth / CELL));
  const span = roofDepth / teeth;
  for (let index = 0; index < teeth; index += 1) {
    const z = roofZ0 + span * (index + 0.5);
    ctx.roof.add(TOOTH, C(color), cx, ctx.roofY, z, width - 0.6, height, span);
    ctx.glass.block(C(glass), cx, ctx.roofY + 0.1, z + span / 2 + 0.06, width - 1, height * 0.85, 0.06);
  }
  ctx.roof.block(C(color), cx, ctx.roofY - 0.25, roofZ0 + roofDepth / 2, width - 0.4, 0.25, roofDepth + 0.4);
}

function lattice(m: Merger, color: THREE.Color, x: number, z: number, h: number, base: number): void {
  const top = base * 0.25;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  const at = (corner: (typeof corners)[number], y: number): THREE.Vector3 => {
    const w = base + (top - base) * (y / h);
    return new THREE.Vector3(x + (corner[0] * w) / 2, y, z + (corner[1] * w) / 2);
  };
  for (const corner of corners) m.beam(color, at(corner, 0), at(corner, h), 0.07);
  for (let y = 0; y < h - 1; y += 2.2) {
    for (let index = 0; index < 4; index += 1) {
      const a = corners[index] as (typeof corners)[number];
      const b = corners[(index + 1) % 4] as (typeof corners)[number];
      m.beam(color, at(a, y), at(b, y + 2.2), 0.04);
      m.beam(color, at(a, y + 2.2), at(b, y + 2.2), 0.04);
    }
  }
}

function container(m: Merger, color: THREE.Color, x: number, y: number, z: number, along: 'x' | 'z'): void {
  const [w, d] = along === 'x' ? [6, 2.4] : [2.4, 6];
  m.block(color, x, y, z, w, 2.5, d);
  const rib = color.clone().multiplyScalar(0.7);
  for (let s = -2.4; s <= 2.4; s += 0.8) {
    if (along === 'x') m.block(rib, x + s, y + 0.05, z, 0.1, 2.4, d + 0.06);
    else m.block(rib, x, y + 0.05, z + s, w + 0.06, 2.4, 0.1);
  }
}

function lighthouse(ctx: StyleContext, x: number, z: number, a: string, b: string): void {
  const height = 13;
  for (let y = 0; y < height; y += 1.6) ctx.m.add(CYL, C(Math.round(y / 1.6) % 2 === 0 ? a : b), x, y + 0.8, z, 2.2 - y * 0.06, 1.6, 2.2 - y * 0.06);
  ctx.m.add(CYL, C('#2a2f35'), x, height + 0.15, z, 1.9, 0.3, 1.9);
  ctx.lit.add(CYL, C('#fff2a8'), x, height + 0.9, z, 1.1, 1.2, 1.1);
  ctx.m.add(SPHERE, C('#2a2f35'), x, height + 1.6, z, 1.5, 1, 1.5);
  ctx.posts.push({ x, z, r: 1.2, h: height });
}

export const STYLES: Record<ZoneId, Style> = {
  materials: {
    name: 'Timber yard',
    meaning: 'Packages arrive here from the npm registry and are stored as they come, so it is an open yard: a fence, log piles and a crane, but no roof.',
    build(ctx) {
      floor(ctx, '#a48a63');
      const { plot } = ctx;
      const wood = C('#8a5a33');
      const fence = (ax: number, az: number, bx: number, bz: number): void => {
        const length = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(1, Math.round(length / 2.5));
        for (let index = 0; index <= steps; index += 1) {
          const x = ax + ((bx - ax) * index) / steps;
          const z = az + ((bz - az) * index) / steps;
          ctx.m.block(wood, x, 0, z, 0.2, 1.4, 0.2);
        }
        for (const y of [0.45, 1.05]) ctx.m.block(wood, (ax + bx) / 2, y, (az + bz) / 2, Math.abs(bx - ax) + 0.1, 0.12, Math.abs(bz - az) + 0.1);
        solid(ctx, ax - 0.15, bx + 0.15, az - 0.15, bz + 0.15, 1.4);
      };
      const x0 = plot.minX + 0.4;
      const x1 = plot.maxX - 0.4;
      const z0 = plot.minZ + 0.4;
      const z1 = plot.maxZ - 0.4;
      fence(x0, z0, x1, z0);
      fence(x0, z0, x0, z1);
      fence(x1, z0, x1, z1);
      fence(x0, z1, plot.hub.x - 4, z1);
      fence(plot.hub.x + 4, z1, x1, z1);
      // Log piles along the north fence.
      const log = C('#9b6b3f');
      for (let x = plot.minX + 3; x < plot.maxX - 4; x += 9) {
        for (const [row, count] of [[0, 4], [1, 3], [2, 2]] as const) {
          for (let index = 0; index < count; index += 1) ctx.m.add(CYL, log, x + (index - (count - 1) / 2) * 0.62, 0.3 + row * 0.53, plot.minZ + 1.4, 0.6, 3, 0.6, Math.PI / 2, 0, 0);
        }
        solid(ctx, x - 1.4, x + 1.4, plot.minZ + 0.6, plot.minZ + 2.2, 1.6);
      }
      // An A-frame log crane over the west end.
      const steel = C('#4b5560');
      const cz = (plot.minZ + plot.maxZ) / 2;
      for (const z of [plot.minZ + 2, plot.maxZ - 8]) {
        ctx.m.beam(steel, new THREE.Vector3(plot.minX + 1.2, 0, z), new THREE.Vector3(plot.minX + 2.2, 9, z), 0.14);
        ctx.m.beam(steel, new THREE.Vector3(plot.minX + 3.2, 0, z), new THREE.Vector3(plot.minX + 2.2, 9, z), 0.14);
        ctx.posts.push({ x: plot.minX + 1.2, z, r: 0.25, h: 9 }, { x: plot.minX + 3.2, z, r: 0.25, h: 9 });
      }
      ctx.m.beam(C('#f2c230'), new THREE.Vector3(plot.minX + 2.2, 9, plot.minZ + 2), new THREE.Vector3(plot.minX + 2.2, 9, plot.maxZ - 8), 0.2);
      ctx.m.beam(C('#2a2f35'), new THREE.Vector3(plot.minX + 2.2, 9, cz), new THREE.Vector3(plot.minX + 2.2, 5, cz), 0.03);
      ctx.m.block(C('#f2c230'), plot.minX + 2.2, 4.4, cz, 0.6, 0.6, 0.6);
    },
  },

  foundry: {
    name: 'Brick forge',
    meaning: 'The rules engine (src/game.ts and session/) is the core that the server, the device and the Nearby host all run, so it is forged here: a brick foundry with a slate roof and glowing chimneys.',
    build(ctx) {
      floor(ctx, '#3d3836');
      walls(ctx, '#9b4a35', 2.2, 0.35, '#6d3324');
      const { plot } = ctx;
      const { cx, width, roofCz, roofDepth } = frame(plot);
      gable(ctx.roof, C('#4a4442'), cx, ctx.roofY, roofCz, width + 0.6, roofDepth + 1, 3.4);
      // Chimneys stand on the north wall, so they stay when the roof lifts.
      const brick = C('#8a3f2c');
      for (const x of [plot.minX + 3, cx, plot.maxX - 3]) {
        const h = ctx.roofY + 7;
        ctx.m.block(brick, x, 0, plot.minZ + 1.2, 1.6, h, 1.6);
        ctx.m.block(C('#3b2a24'), x, h, plot.minZ + 1.2, 1.9, 0.4, 1.9);
        ctx.lit.block(C('#ff7a2a'), x, h + 0.4, plot.minZ + 1.2, 1.2, 0.15, 1.2);
        ctx.posts.push({ x, z: plot.minZ + 1.2, r: 1, h });
      }
      // A ladle of molten metal by the door.
      ctx.m.add(CYL, C('#3b3533'), plot.hub.x + 6, 0.6, plot.maxZ - 3, 1.6, 1.2, 1.6);
      ctx.lit.add(CYL, C('#ff8a1a'), plot.hub.x + 6, 1.22, plot.maxZ - 3, 1.3, 0.05, 1.3);
      ctx.posts.push({ x: plot.hub.x + 6, z: plot.maxZ - 3, r: 0.9, h: 1.2 });
    },
  },

  api: {
    name: 'Steel and glass hall',
    meaning: 'The API is the modern heart of the system, always on: a steel hall with a glazed sawtooth roof, open toward its loading docks. The water wheel on the canal powers it.',
    build(ctx) {
      floor(ctx, '#c4c9ce');
      columns(ctx, '#56616d', ctx.roofY);
      sawtooth(ctx, '#6f7b88', '#9fd3f5', 2.4);
    },
  },

  vault: {
    name: 'Concrete bunker',
    meaning: 'The DuckDB file must survive restarts and deploys (it lives on a Docker volume), so the vault has thick concrete walls and a flat bunker roof with vents.',
    build(ctx) {
      floor(ctx, '#55595e');
      walls(ctx, '#8e9196', 3, 0.9, '#7a7d82');
      const { cx, width, roofCz, roofDepth } = frame(ctx.plot);
      ctx.roof.block(C('#7e8186'), cx, ctx.roofY, roofCz, width - 0.4, 0.8, roofDepth + 1);
      for (let x = ctx.plot.minX + 4; x < ctx.plot.maxX - 3; x += 6) ctx.roof.add(CYL, C('#5c6066'), x, ctx.roofY + 1.3, roofCz, 0.9, 1.2, 0.9);
    },
  },

  acoustics: {
    name: 'Concert hall',
    meaning: 'Sound, music and voice live here, so it is a wooden concert hall: a barrel-vaulted roof and organ pipes along the back wall.',
    build(ctx) {
      floor(ctx, '#b07d4f');
      walls(ctx, '#7a4b2a', 1.6, 0.3, '#5a3519');
      const { plot } = ctx;
      const { cx, width, roofCz, roofDepth } = frame(plot);
      ctx.roof.add(VAULT, C('#c58b55'), cx, ctx.roofY - 1, roofCz, width, 7, roofDepth + 1);
      const pipe = C('#d4d8dc');
      let index = 0;
      for (let x = plot.minX + 2; x < plot.maxX - 1.5; x += 0.9) {
        const h = 3 + Math.abs(Math.sin(index * 0.55)) * 6;
        ctx.m.add(CYL, pipe, x, h / 2, plot.minZ + 1.1, 0.6, h, 0.6);
        ctx.m.add(CYL, C('#2a2f35'), x, h * 0.25, plot.minZ + 1.38, 0.3, 0.14, 0.08);
        index += 1;
      }
      solid(ctx, plot.minX + 1.6, plot.maxX - 1.3, plot.minZ + 0.7, plot.minZ + 1.5, 9);
    },
  },

  ai: {
    name: 'Clean-room dome',
    meaning: 'The computer opponent searches moves in a Web Worker, its own thread, sealed off from the page. So the lab is a sealed dome with an airlock, and it has its own small windmill.',
    build(ctx) {
      floor(ctx, '#eef1f4');
      walls(ctx, '#f6f7f9', 1, 0.3, '#c9d2dc');
      const { cx, width, roofCz, roofDepth } = frame(ctx.plot);
      ctx.glass.add(DOME, C('#f2f7ff'), cx, 0.9, roofCz, width - 1, Math.max(ctx.roofY + 2, 9) * 2, roofDepth + 2);
      ctx.roof.add(CYL, C('#c9d2dc'), cx, 0.9 + Math.max(ctx.roofY + 2, 9), roofCz, 1.2, 0.6, 1.2);
      // The airlock at the door.
      const { plot } = ctx;
      ctx.m.block(C('#dfe5ec'), plot.hub.x - 4.6, 0, plot.maxZ - 0.5, 1.2, 3, 1.2);
      ctx.m.block(C('#dfe5ec'), plot.hub.x + 4.6, 0, plot.maxZ - 0.5, 1.2, 3, 1.2);
      ctx.m.block(C('#dfe5ec'), plot.hub.x, 3, plot.maxZ - 0.5, 10.4, 0.6, 1.2);
      ctx.lit.block(C('#7dd3fc'), plot.hub.x, 3.6, plot.maxZ - 0.5, 9, 0.08, 0.4);
    },
  },

  nearby: {
    name: 'Radio masts',
    meaning: 'Nearby play connects two devices directly over WebRTC, with no server in between, so it is an open field of radio masts beaming at each other.',
    build(ctx) {
      floor(ctx, '#7c8576');
      const { plot } = ctx;
      const steel = C('#c8473b');
      for (const [x, facing] of [[plot.minX + 2.5, 1], [plot.maxX - 2.5, -1]] as const) {
        const z = plot.minZ + 2.5;
        lattice(ctx.m, steel, x, z, 20, 2.2);
        ctx.m.add(SPHERE, C('#e6e9ec'), x + facing * 0.9, 16, z + 0.6, 0.6, 2.4, 2.4);
        ctx.lit.add(SPHERE, C('#ff4d4d'), x, 20.3, z, 0.5, 0.5, 0.5);
        ctx.posts.push({ x, z, r: 1.3, h: 20 });
      }
    },
  },

  storefront: {
    name: 'Shopfronts',
    meaning: 'The HTML pages are the doors players walk in through, so this is a street of shops: one gabled roof per row of machines, with striped awnings.',
    build(ctx) {
      floor(ctx, '#d8cfc0');
      const { plot } = ctx;
      const { roofCz, roofDepth } = frame(plot);
      const colors = ['#c0392b', '#2e86ab', '#27ae60', '#e67e22', '#8e44ad'];
      let index = 0;
      for (let x = plot.minX + 3; x < plot.maxX - 3; x += CELL) {
        const color = C(colors[index % colors.length] ?? '#c0392b');
        gable(ctx.roof, color, x + CELL / 2, ctx.roofY, roofCz, CELL - 0.3, roofDepth + 0.6, 2.6);
        // An awning in stripes over the front of each shop.
        for (let s = 0; s < 5; s += 1) ctx.m.block(s % 2 === 0 ? color : C('#f4f1ea'), x + 0.5 + s * 0.8, 2.8, roofCz + roofDepth / 2 + 0.6, 0.8, 0.12, 1.4);
        index += 1;
      }
      columns(ctx, '#3d3a36', ctx.roofY);
    },
  },

  assembly: {
    name: 'Red-brick factory',
    meaning: 'The page modules are put together here into what players see: a classic red-brick factory with a sawtooth roof and a water tower.',
    build(ctx) {
      floor(ctx, '#8c8f93');
      walls(ctx, '#a5503a', 1.8, 0.35, '#7e3a28');
      sawtooth(ctx, '#5b5f66', '#bfe3f7', 2.6);
      const { plot } = ctx;
      const x = plot.maxX - 3;
      const z = plot.minZ + 3;
      const legs = C('#4b4f55');
      for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [1.2, 1.2], [-1.2, 1.2]] as const) ctx.m.block(legs, x + dx, 0, z + dz, 0.2, ctx.roofY + 4, 0.2);
      ctx.m.add(CYL, C('#7a5136'), x, ctx.roofY + 5.5, z, 3.4, 3, 3.4);
      ctx.m.add(GABLE, C('#4b4f55'), x, ctx.roofY + 7, z, 3.6, 1.2, 3.6);
      ctx.posts.push({ x, z, r: 1.6, h: ctx.roofY + 7 });
    },
  },

  device: {
    name: 'Storage warehouse',
    meaning: 'The device keeps games and results offline in IndexedDB until they can be uploaded, so this is a warehouse with tall storage racks along the back wall.',
    build(ctx) {
      floor(ctx, '#9aa0a6');
      walls(ctx, '#6e8fa6', 2.6, 0.3, '#577489');
      const { plot } = ctx;
      const { cx, width, roofCz, roofDepth } = frame(plot);
      gable(ctx.roof, C('#8aa3b5'), cx, ctx.roofY, roofCz, width, roofDepth + 1, 1.6);
      ctx.glass.block(C('#cfe9fb'), cx, ctx.roofY + 0.85, roofCz, width - 2, 0.1, 1.4);
      // Racks: frames with shelves of boxes.
      const rack = C('#e07b39');
      const boxes = [C('#c9a46a'), C('#b38b55'), C('#d6b47a')];
      for (let x = plot.minX + 2; x < plot.maxX - 2; x += 2.6) {
        ctx.m.block(rack, x - 1.2, 0, plot.minZ + 1.3, 0.12, 6, 0.12);
        for (let level = 0; level < 4; level += 1) {
          ctx.m.block(rack, x, 0.2 + level * 1.5, plot.minZ + 1.3, 2.4, 0.08, 1.1);
          ctx.m.block(boxes[(level + Math.round(x)) % 3] as THREE.Color, x - 0.4 + (level % 2) * 0.6, 0.28 + level * 1.5, plot.minZ + 1.3, 0.9, 0.8, 0.8);
        }
      }
      solid(ctx, plot.minX + 0.7, plot.maxX - 0.7, plot.minZ + 0.7, plot.minZ + 1.9, 6);
    },
  },

  qa: {
    name: 'Proving ground',
    meaning: 'Tests prove that the machines work: an open test track with a checkered start line, flags and a small grandstand, and no roof.',
    build(ctx) {
      floor(ctx, '#4a4d52');
      const { plot } = ctx;
      const { cx, width, depth, cz } = frame(plot);
      const white = C('#f4f4f4');
      ctx.m.block(white, cx, 0.03, plot.minZ + 1, width - 1.6, 0.03, 0.15);
      ctx.m.block(white, cx, 0.03, plot.maxZ - 1, width - 1.6, 0.03, 0.15);
      ctx.m.block(white, plot.minX + 0.8, 0.03, cz, 0.15, 0.03, depth - 1.6);
      ctx.m.block(white, plot.maxX - 0.8, 0.03, cz, 0.15, 0.03, depth - 1.6);
      for (let index = 0; index < 16; index += 1) {
        for (let row = 0; row < 2; row += 1) ctx.m.block((index + row) % 2 === 0 ? white : C('#16181b'), plot.minX + 4 + index * 0.5, 0.035, plot.maxZ - 2.2 + row * 0.5, 0.5, 0.03, 0.5);
      }
      for (const [x, z] of [[plot.minX + 0.8, plot.minZ + 0.8], [plot.maxX - 0.8, plot.minZ + 0.8], [plot.minX + 0.8, plot.maxZ - 0.8], [plot.maxX - 0.8, plot.maxZ - 0.8]] as const) {
        ctx.m.block(white, x, 0, z, 0.1, 4.6, 0.1);
        ctx.m.block(C('#7dff6a'), x + 0.6, 3.6, z, 1.1, 0.7, 0.04);
      }
      // A grandstand along the north side.
      for (let step = 0; step < 4; step += 1) ctx.m.block(C('#9aa1a9'), cx, 0, plot.minZ - 1.4 - step * 0.8, width * 0.6, 0.6 + step * 0.6, 0.8);
      solid(ctx, cx - width * 0.3, cx + width * 0.3, plot.minZ - 4.8, plot.minZ - 1, 2.4);
    },
  },

  ci: {
    name: 'Rail yard',
    meaning: 'GitHub Actions run jobs on triggers and schedules, like trains on a timetable: a rail yard with a station canopy and signal gantries. Steam engines (the runners) power it.',
    build(ctx) {
      floor(ctx, '#8b857c');
      const { plot } = ctx;
      const { cx, width, roofCz, roofDepth } = frame(plot);
      // A butterfly canopy on columns.
      columns(ctx, '#3b4a5a', ctx.roofY);
      ctx.roof.block(C('#4d6a87'), cx, ctx.roofY - 0.1, roofCz, width, 0.2, roofDepth + 1);
      gable(ctx.roof, C('#5d7d9c'), cx, ctx.roofY + 0.1, roofCz, width, roofDepth + 1, 1);
      // Rails along the north edge.
      const z = plot.minZ + 1;
      for (let x = plot.minX + 0.6; x < plot.maxX - 0.5; x += 0.7) ctx.m.block(C('#6b4f3a'), x, 0, z, 0.25, 0.08, 1.6);
      for (const dz of [-0.5, 0.5]) ctx.m.block(C('#9aa1a9'), cx, 0.08, z + dz, width - 1, 0.1, 0.08);
      // A signal gantry over the door.
      const gantry = C('#2a2f35');
      ctx.m.block(gantry, plot.hub.x - 4.5, 0, plot.maxZ - 0.6, 0.25, 6, 0.25);
      ctx.m.block(gantry, plot.hub.x + 4.5, 0, plot.maxZ - 0.6, 0.25, 6, 0.25);
      ctx.m.block(gantry, plot.hub.x, 6, plot.maxZ - 0.6, 9.4, 0.3, 0.3);
      for (const [index, color] of ['#ff4d4d', '#ffb000', '#5dff7a'].entries()) ctx.lit.add(SPHERE, C(color), plot.hub.x - 1.2 + index * 1.2, 5.6, plot.maxZ - 0.6, 0.45, 0.45, 0.45);
      ctx.posts.push({ x: plot.hub.x - 4.5, z: plot.maxZ - 0.6, r: 0.25, h: 6 }, { x: plot.hub.x + 4.5, z: plot.maxZ - 0.6, r: 0.25, h: 6 });
    },
  },

  packaging: {
    name: 'Container port',
    meaning: 'The build is packed into Docker images and shipped to the server: a container port with stacks of shipping containers and a gantry crane, by the river.',
    build(ctx) {
      floor(ctx, '#55585c');
      const { plot } = ctx;
      const { cx, width } = frame(plot);
      const colors = ['#2496ed', '#e95420', '#3ddc84', '#f2c230', '#8a63d2'].map(C);
      let index = 0;
      for (let x = plot.minX + 3.5; x < plot.maxX - 3; x += 6.4) {
        for (let level = 0; level < 1 + (index % 3); level += 1) container(ctx.m, colors[(index + level) % colors.length] as THREE.Color, x, level * 2.5, plot.minZ - 1.8, 'x');
        index += 1;
      }
      solid(ctx, plot.minX + 0.4, plot.maxX - 0.4, plot.minZ - 3, plot.minZ - 0.6, 7.5);
      // A gantry crane spanning the plot.
      const crane = C('#f2a03d');
      const h = ctx.roofY + 4;
      for (const x of [plot.minX + 0.8, plot.maxX - 0.8]) {
        for (const z of [plot.minZ + 1, plot.maxZ - 6]) {
          ctx.m.block(crane, x, 0, z, 0.5, h, 0.5);
          ctx.posts.push({ x, z, r: 0.4, h });
        }
        ctx.m.block(crane, x, h, (plot.minZ + plot.maxZ - 5) / 2, 0.6, 0.6, plot.maxZ - plot.minZ - 6.5);
      }
      ctx.m.block(crane, cx, h + 0.6, plot.minZ + 1, width - 1, 0.8, 0.8);
      ctx.m.block(crane, cx, h + 0.6, plot.maxZ - 6, width - 1, 0.8, 0.8);
      ctx.m.block(C('#2a2f35'), cx, h - 0.6, (plot.minZ + plot.maxZ - 5) / 2, 2, 1.2, 2);
    },
  },

  android: {
    name: 'Harbour pier',
    meaning: 'The Android app leaves by sea for Google Play: a wooden pier with bollards, a canopy and a green lighthouse.',
    build(ctx) {
      harbour(ctx, '#3ddc84');
    },
  },

  ios: {
    name: 'Harbour pier',
    meaning: 'The iOS app leaves by sea for TestFlight and the App Store: a wooden pier with bollards, a canopy and a silver lighthouse.',
    build(ctx) {
      harbour(ctx, '#c7ccd3');
    },
  },

  studio: {
    name: 'Soundstages',
    meaning: 'The ad and the tutorial videos are rendered here with Remotion: arched soundstage hangars with big studio doors.',
    build(ctx) {
      floor(ctx, '#7d7f84');
      walls(ctx, '#b9b2a5', 1.2, 0.3);
      const { plot } = ctx;
      const { width, roofCz, roofDepth } = frame(plot);
      const halls = width > 40 ? 2 : 1;
      const span = (width - 1) / halls;
      for (let index = 0; index < halls; index += 1) {
        const x = plot.minX + 0.5 + span * (index + 0.5);
        ctx.roof.add(VAULT, C('#c9c2b5'), x, ctx.roofY - 3, roofCz, span - 0.4, 8, roofDepth + 1);
        ctx.roof.block(C('#9b9385'), x, ctx.roofY - 3, roofCz + roofDepth / 2 + 0.5, span * 0.5, 3.2, 0.2);
      }
      // A spotlight rig.
      ctx.lit.add(SPHERE, C('#fff7d6'), plot.minX + 2, 6, plot.maxZ - 2, 0.8, 0.8, 0.8);
      ctx.m.block(C('#2a2f35'), plot.minX + 2, 0, plot.maxZ - 2, 0.15, 5.6, 0.15);
      ctx.posts.push({ x: plot.minX + 2, z: plot.maxZ - 2, r: 0.3, h: 6 });
    },
  },
};

function harbour(ctx: StyleContext, light: string): void {
  floor(ctx, '#9c7a55');
  const { plot } = ctx;
  const { cx, width, depth, cz, roofCz, roofDepth } = frame(plot);
  // Deck planks.
  for (let x = plot.minX + 1; x < plot.maxX - 0.5; x += 1.2) ctx.m.block(C('#7f6143'), x, 0.02, cz, 0.06, 0.02, depth - 1);
  // Bollards along the front.
  for (let x = plot.minX + 2; x < plot.maxX - 1; x += 4) {
    if (Math.abs(x - plot.hub.x) < 4.5) continue;
    ctx.m.add(CYL, C('#2a2f35'), x, 0.4, plot.maxZ - 0.6, 0.5, 0.8, 0.5);
    ctx.posts.push({ x, z: plot.maxZ - 0.6, r: 0.3, h: 0.8 });
  }
  // A canopy on columns.
  columns(ctx, '#3d4752', ctx.roofY);
  gable(ctx.roof, ctx.zone.clone().lerp(C('#ffffff'), 0.35), cx, ctx.roofY, roofCz, width, roofDepth + 1, 1.8);
  lighthouse(ctx, plot.maxX - 2.2, plot.maxZ - 3, light, '#f4f4f4');
}


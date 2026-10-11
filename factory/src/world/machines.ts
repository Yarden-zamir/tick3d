// The machines. Static parts of every zone merge into one mesh with vertex colors (a few draw calls
// for the whole map). Moving parts (gears, fans, presses, drones, lamps) are instanced and animate
// every frame. Each entity also gets an invisible pick box and a bounding box for the selection gizmo.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Entity, FactoryModel, ZoneId } from '../../scan/model.ts';
import { CELL, type Layout, type Place, type Plot } from '../layout.ts';
import { ZONES } from '../lore.ts';

const C = (hex: string): THREE.Color => new THREE.Color(hex);
const DARK = C('#2a2f35');
const METAL = C('#6f7782');
const STEEL = C('#a3abb5');
const CONCRETE = C('#7a7f86');
const WOOD = C('#a0713f');
const HAZARD = C('#f2c230');
const CREAM = C('#ece4cc');
const GLASS = C('#7fb8e0');
const BUSY = C('#fff2a8');

export const METHOD_COLORS: Record<string, string> = { GET: '#3ddc84', POST: '#4d7cfe', PUT: '#ffb000', PATCH: '#ffb000', DELETE: '#ff4d4d' };
const TRIGGER_COLORS: Record<string, string> = {
  push: '#ffd23f',
  pull_request: '#a06cf5',
  schedule: '#00c2ff',
  workflow_dispatch: '#f5f5f5',
  deployment_status: '#3ddc84',
};
const RUNNER_COLORS = { macos: '#d4d8de', ubuntu: '#e95420', reusable: '#8a63d2' };
const STAGE_COLORS: Record<string, string> = { build: '#f2a03d', api: '#4d7cfe', site: '#3ddc84' };

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const CONE = new THREE.ConeGeometry(0.5, 1, 20);
const SPHERE = new THREE.SphereGeometry(0.5, 20, 14);

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();

class Merger {
  private parts: THREE.BufferGeometry[] = [];

  add(template: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): void {
    const geometry = template.clone();
    tmpMatrix.compose(tmpPos.set(x, y, z), tmpQuat.setFromEuler(tmpEuler.set(rx, ry, rz)), tmpScale.set(sx, sy, sz));
    geometry.applyMatrix4(tmpMatrix);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) colors.set([color.r, color.g, color.b], index * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(geometry);
  }

  /** A box that stands on y0 and rises by h. */
  block(color: THREE.Color, x: number, y0: number, z: number, w: number, h: number, d: number, ry = 0): void {
    this.add(BOX, color, x, y0 + h / 2, z, w, h, d, 0, ry, 0);
  }

  cylinder(color: THREE.Color, x: number, y0: number, z: number, r: number, h: number, low = false): void {
    this.add(low ? CYL8 : CYL, color, x, y0 + h / 2, z, r * 2, h, r * 2);
  }

  build(material: THREE.Material): THREE.Mesh | undefined {
    if (this.parts.length === 0) return undefined;
    const geometry = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts = [];
    if (!geometry) return undefined;
    geometry.computeBoundingSphere();
    return new THREE.Mesh(geometry, material);
  }
}

type LampMode = 'status' | 'night' | 'fixed' | 'test';

interface Lamp {
  id: string;
  color: THREE.Color;
  mode: LampMode;
  phase: number;
}

interface Spinner {
  id: string;
  x: number;
  y: number;
  z: number;
  axis: 'y' | 'z';
  scale: number;
  speed: number;
  angle: number;
}

interface Piston {
  id: string;
  x: number;
  z: number;
  low: number;
  high: number;
  size: number;
  phase: number;
}

interface Drone {
  id: string;
  x: number;
  z: number;
  phase: number;
}

export interface Post {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface Machines {
  group: THREE.Group;
  bounds: Map<string, THREE.Box3>;
  /** The point above an entity where packets land and labels float. */
  tops: Map<string, THREE.Vector3>;
  hubs: Map<ZoneId, THREE.Vector3>;
  pick: THREE.InstancedMesh;
  pickIds: string[];
  slabs: THREE.Mesh[];
  /** Round solid things a walker bumps into: roof columns, lamp and sign posts, hubs. */
  posts: Post[];
  roofs: Map<ZoneId, { group: THREE.Group; panel: THREE.MeshStandardMaterial; truss: THREE.MeshStandardMaterial; lift: number }>;
  materials: THREE.Material[];
  update(dt: number, time: number, activity: Map<string, number>, night: number): void;
}

function signTexture(plot: Plot, model: FactoryModel): THREE.CanvasTexture {
  const zone = ZONES[plot.zone];
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#1d2126';
  ctx.fillRect(0, 0, 1024, 384);
  ctx.fillStyle = zone.color;
  ctx.fillRect(0, 0, 26, 384);
  // Hazard stripes along the bottom.
  for (let x = -40; x < 1024; x += 56) {
    ctx.fillStyle = '#f2c230';
    ctx.beginPath();
    ctx.moveTo(x, 384);
    ctx.lineTo(x + 28, 384);
    ctx.lineTo(x + 52, 352);
    ctx.lineTo(x + 24, 352);
    ctx.fill();
  }
  ctx.fillStyle = zone.color;
  ctx.font = '700 110px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(zone.icon || '◆', 60, 150);
  ctx.fillStyle = '#f4f4f4';
  ctx.font = '800 76px Inter, system-ui, sans-serif';
  ctx.fillText(zone.title.toUpperCase(), 210, 120, 790);
  ctx.fillStyle = '#aeb6bf';
  ctx.font = '500 34px Inter, system-ui, sans-serif';
  ctx.fillText(zone.holds, 212, 200, 790);
  const files = model.entities.filter((entity) => entity.zone === plot.zone && entity.lines !== undefined);
  const lines = files.reduce((sum, entity) => sum + (entity.lines ?? 0), 0);
  ctx.fillStyle = zone.color;
  ctx.font = '600 32px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`${plot.entities.length} machines · ${files.length} files · ${lines.toLocaleString()} lines`, 212, 282, 790);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export function buildMachines(model: FactoryModel, layout: Layout): Machines {
  const group = new THREE.Group();
  const bounds = new Map<string, THREE.Box3>();
  const tops = new Map<string, THREE.Vector3>();
  const hubs = new Map<ZoneId, THREE.Vector3>();
  const posts: Post[] = [];
  const lamps: { lamp: Lamp; matrix: THREE.Matrix4 }[] = [];
  const gears: Spinner[] = [];
  const fans: Spinner[] = [];
  const rings: Spinner[] = [];
  const pistons: Piston[] = [];
  const drones: Drone[] = [];
  const slabs: THREE.Mesh[] = [];
  const roofs: Machines['roofs'] = new Map();

  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.28 });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  glow.color.setScalar(0.85);
  const materials: THREE.Material[] = [solid];

  const lamp = (id: string, x: number, y: number, z: number, color: THREE.Color | string, mode: LampMode = 'status', size = 1): void => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(size, size, size));
    lamps.push({ lamp: { id, color: typeof color === 'string' ? C(color) : color.clone(), mode, phase: Math.random() * Math.PI * 2 }, matrix });
  };

  for (const plot of layout.plots.values()) {
    const zone = ZONES[plot.zone];
    const zoneColor = C(zone.color);
    const m = new Merger();
    const lit = new Merger();
    const width = plot.maxX - plot.minX;
    const depth = plot.maxZ - plot.minZ;
    const cx = (plot.minX + plot.maxX) / 2;
    const cz = (plot.minZ + plot.maxZ) / 2;

    // The foundation: a concrete slab with a painted zone border.
    const slab = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial());
    slab.position.set(cx, -0.1, cz);
    slab.scale.set(width, 0.24, depth);
    slab.updateMatrixWorld();
    slab.userData.zone = plot.zone;
    slabs.push(slab);
    m.block(CONCRETE, cx, -0.2, cz, width, 0.22, depth);
    const edge = 0.35;
    m.block(zoneColor, cx, 0.02, plot.minZ + edge / 2, width, 0.04, edge);
    m.block(zoneColor, cx, 0.02, plot.maxZ - edge / 2, width, 0.04, edge);
    m.block(zoneColor, plot.minX + edge / 2, 0.02, cz, edge, 0.04, depth);
    m.block(zoneColor, plot.maxX - edge / 2, 0.02, cz, edge, 0.04, depth);
    // Painted walkway between the cells and the front strip.
    const front = plot.hub.z;
    m.block(C('#545a62'), cx, 0.005, front, width - 1.4, 0.02, 2.2);
    for (let x = plot.minX + 1.2; x < plot.maxX - 1.2; x += 2.4) m.block(HAZARD, x, 0.02, front - 1.25, 1.1, 0.02, 0.18);

    // Steel columns that hold the roof, at the corners and along the long sides.
    let tallest = 0;
    for (const entity of plot.entities) tallest = Math.max(tallest, layout.places.get(entity.id)?.h ?? 0);
    const roofY = Math.max(6.5, tallest + 2.6);
    const columns: [number, number][] = [];
    const roofDepth = plot.rows * CELL + 3;
    const roofZ0 = plot.minZ + 1.5;
    for (let x = plot.minX + 1; x <= plot.maxX - 0.9; x += Math.max(CELL * 2, (width - 2) / Math.max(1, Math.round((width - 2) / (CELL * 2))))) {
      columns.push([x, roofZ0], [x, roofZ0 + roofDepth]);
    }
    for (const [x, z] of columns) {
      m.block(DARK, x, 0, z, 0.5, 0.3, 0.5);
      m.block(zoneColor.clone().lerp(METAL, 0.55), x, 0.3, z, 0.32, roofY - 0.3, 0.32);
      posts.push({ x, z, r: 0.3, h: roofY });
    }

    // The roof lifts away when you enter the zone (main.ts animates it).
    const roof = new THREE.Group();
    const truss = new THREE.MeshStandardMaterial({ color: zoneColor.clone().lerp(STEEL, 0.5), vertexColors: true, roughness: 0.5, metalness: 0.6, transparent: true, opacity: 1 });
    const panel = new THREE.MeshStandardMaterial({ color: zoneColor.clone().lerp(C('#ffffff'), 0.25), roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    const beams = new Merger();
    const white = C('#ffffff');
    for (let x = plot.minX + 1; x <= plot.maxX - 0.9; x += CELL) beams.block(white, x, roofY, roofZ0 + roofDepth / 2, 0.22, 0.32, roofDepth);
    beams.block(white, cx, roofY + 0.1, roofZ0, width - 1.6, 0.26, 0.26);
    beams.block(white, cx, roofY + 0.1, roofZ0 + roofDepth, width - 1.6, 0.26, 0.26);
    for (let z = roofZ0 + CELL; z < roofZ0 + roofDepth; z += CELL) beams.block(white, cx, roofY + 0.32, z, width - 1.6, 0.14, 0.14);
    const beamMesh = beams.build(truss);
    // The beams carry white vertex colors; the material carries the zone tint.
    if (beamMesh) roof.add(beamMesh);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(width - 1.6, roofDepth), panel);
    glass.rotation.x = -Math.PI / 2;
    glass.position.set(cx, roofY + 0.36, roofZ0 + roofDepth / 2);
    glass.renderOrder = 2;
    roof.add(glass);
    group.add(roof);
    roofs.set(plot.zone, { group: roof, panel, truss, lift: 0 });
    materials.push(truss, panel);

    // Lamp posts at the four corners: they light up at night.
    for (const [x, z] of [[plot.minX + 0.8, plot.minZ + 0.8], [plot.maxX - 0.8, plot.minZ + 0.8], [plot.minX + 0.8, plot.maxZ - 0.8], [plot.maxX - 0.8, plot.maxZ - 0.8]] as const) {
      m.block(DARK, x, 0, z, 0.18, 4.2, 0.18);
      posts.push({ x, z, r: 0.15, h: 4.2 });
      m.block(DARK, x, 4.1, z, 0.5, 0.14, 0.5);
      lamp(`zone:${plot.zone}`, x, 3.95, z, '#ffd9a0', 'night', 1.6);
    }

    // The zone sign at the front.
    const sign = new THREE.Group();
    const signW = 7.2;
    const signH = 2.7;
    m.block(DARK, plot.sign.x - signW / 2 + 0.4, 0, plot.sign.z, 0.22, 1.4 + signH, 0.22);
    m.block(DARK, plot.sign.x + signW / 2 - 0.4, 0, plot.sign.z, 0.22, 1.4 + signH, 0.22);
    for (let x = plot.sign.x - signW / 2 + 0.4; x <= plot.sign.x + signW / 2 - 0.3; x += 0.6) posts.push({ x, z: plot.sign.z, r: 0.2, h: 1.4 + signH });
    const face = new THREE.MeshStandardMaterial({ map: signTexture(plot, model), roughness: 0.6, emissive: C('#ffffff'), emissiveIntensity: 0.05 });
    face.emissiveMap = face.map;
    const backing = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.7 });
    const board = new THREE.Mesh(BOX, [backing, backing, backing, backing, face, backing]);
    board.position.set(plot.sign.x, 1.4 + signH / 2, plot.sign.z);
    board.scale.set(signW, signH, 0.18);
    board.castShadow = true;
    sign.add(board);
    group.add(sign);
    materials.push(face);

    // The hub: where this zone's belts meet the roads to the other zones.
    const hub = new THREE.Vector3(plot.hub.x, 0, plot.hub.z);
    hubs.set(plot.zone, hub);
    m.cylinder(DARK, hub.x, 0, hub.z, 1.25, 0.35, true);
    posts.push({ x: hub.x, z: hub.z, r: 1.25, h: 1.4 });
    m.cylinder(zoneColor, hub.x, 0.35, hub.z, 1.0, 0.45, true);
    m.cylinder(METAL, hub.x, 0.8, hub.z, 0.45, 0.6);
    rings.push({ id: `zone:${plot.zone}`, x: hub.x, y: 1.0, z: hub.z, axis: 'y', scale: 1, speed: 0.8, angle: 0 });
    lamp(`zone:${plot.zone}`, hub.x, 1.55, hub.z, zone.color, 'status', 1.3);

    for (const entity of plot.entities) {
      const place = layout.places.get(entity.id);
      if (!place) continue;
      buildEntity(m, lit, place, zoneColor);
      for (const testId of entity.tests ?? []) {
        const test = layout.places.get(testId);
        if (test) buildTest(m, test);
      }
    }

    const mesh = m.build(solid);
    if (mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.zone = plot.zone;
      group.add(mesh);
    }
    const lights = lit.build(glow);
    if (lights) group.add(lights);
  }

  function box(id: string, x: number, z: number, r: number, h: number): void {
    bounds.set(id, new THREE.Box3(new THREE.Vector3(x - r, 0, z - r), new THREE.Vector3(x + r, h, z + r)));
    tops.set(id, new THREE.Vector3(x, h + 0.6, z));
  }

  function buildTest(m: Merger, place: Place): void {
    const { x, z } = place;
    const qa = C(ZONES.qa.color);
    m.block(DARK, x, 0, z, 0.5, 0.1, 0.9);
    m.block(qa, x, 0.1, z - 0.36, 0.12, 1.45, 0.12);
    m.block(qa, x, 0.1, z + 0.36, 0.12, 1.45, 0.12);
    m.block(qa.clone().lerp(DARK, 0.3), x, 1.5, z, 0.2, 0.16, 0.9);
    lamp(place.entity.id, x, 1.72, z, '#7dff6a', 'test', 0.8);
    box(place.entity.id, x, z, 0.5, 1.8);
  }

  function buildEntity(m: Merger, lit: Merger, place: Place, zoneColor: THREE.Color): void {
    const { entity, x, z, h } = place;
    const id = entity.id;
    const data = entity.data ?? {};
    const body = zoneColor.clone().lerp(STEEL, 0.42);
    switch (entity.kind) {
      case 'module':
      case 'test': {
        // The assembler: plinth, body, color band, cap, chimney, a gear on the front and a status lamp.
        m.block(DARK, x, 0, z, 2.7, 0.25, 2.7);
        m.block(body, x, 0.25, z, 2.3, h - 0.45, 2.3);
        m.block(zoneColor, x, 0.25 + (h - 0.45) * 0.72, z, 2.38, 0.2, 2.38);
        m.block(DARK, x, h - 0.2, z, 2.5, 0.22, 2.5);
        m.block(DARK, x + 1.25, 0.12, z + 0.5, 0.35, 0.45, 0.7);
        m.block(DARK, x - 0.5, 0.12, z + 1.25, 0.7, 0.45, 0.35);
        m.cylinder(METAL, x + 0.72, h, z - 0.72, 0.2, 0.7 + Math.min(1.4, h * 0.12));
        // Small windows that glow: the lines of code at work.
        const windows = Math.max(1, Math.min(4, Math.floor(h / 1.4)));
        for (let index = 0; index < windows; index += 1) lit.block(GLASS, x - 0.55, 0.65 + index * 1.15, z + 1.16, 0.7, 0.42, 0.04);
        gears.push({ id, x: x + 0.45, y: Math.min(h * 0.45, 1.6), z: z + 1.2, axis: 'z', scale: 0.85 + Math.min(0.6, h / 12), speed: 1 + Math.random(), angle: Math.random() * 6 });
        if ((entity.lines ?? 0) > 300) fans.push({ id, x: x - 0.4, y: h + 0.05, z: z - 0.2, axis: 'y', scale: 1, speed: 3 + Math.random() * 2, angle: 0 });
        if (id.endsWith('ai-worker.ts')) {
          // The worker runs in its own sealed thread: a glass dome.
          lit.add(SPHERE, C('#ff9bbd'), x, h + 0.1, z, 1.6, 1.2, 1.6);
        }
        lamp(id, x - 0.75, h + 0.15, z + 0.75, '#5dff7a');
        box(id, x, z, 1.35, h + 0.3);
        break;
      }
      case 'script': {
        m.cylinder(DARK, x, 0, z, 0.9, 0.35);
        m.cylinder(body, x, 0.35, z, 0.55, 0.5);
        m.block(zoneColor, x, 0.85, z, 0.4, h * 0.6, 0.4);
        m.block(zoneColor, x + 0.55, 0.85 + h * 0.6 - 0.2, z, 1.4, 0.3, 0.3);
        m.block(DARK, x + 1.15, 0.85 + h * 0.6 - 0.65, z, 0.2, 0.5, 0.5);
        lamp(id, x, 0.85 + h * 0.6 + 0.1, z, '#5dff7a');
        box(id, x + 0.2, z, 1.3, 0.85 + h * 0.6 + 0.2);
        break;
      }
      case 'spec': {
        // A drone pad: Playwright flies from here to the preview.
        m.cylinder(DARK, x, 0, z, 1.25, 0.12);
        m.cylinder(C(ZONES.qa.color), x, 0.12, z, 1.0, 0.03);
        m.cylinder(DARK, x, 0.15, z, 0.85, 0.02);
        m.block(C('#f4f4f4'), x - 0.25, 0.17, z, 0.08, 0.01, 0.6);
        m.block(C('#f4f4f4'), x + 0.25, 0.17, z, 0.08, 0.01, 0.6);
        m.block(C('#f4f4f4'), x, 0.17, z, 0.5, 0.01, 0.08);
        drones.push({ id, x, z, phase: Math.random() * 6 });
        box(id, x, z, 1.25, 2.2);
        break;
      }
      case 'style': {
        // The paint mixer: a tank on legs with a cone top and a mixer on the lid.
        for (const [dx, dz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]] as const) m.block(DARK, x + dx, 0, z + dz, 0.18, 0.6, 0.18);
        m.cylinder(zoneColor.clone().lerp(C('#ff7ad9'), 0.35), x, 0.6, z, 1.05, h - 1.2);
        m.cylinder(DARK, x, 0.6 + (h - 1.2) * 0.5, z, 1.09, 0.14);
        m.add(CONE, METAL, x, h - 0.6 + 0.3, z, 2.1, 0.6, 2.1);
        fans.push({ id, x, y: h + 0.05, z, axis: 'y', scale: 0.8, speed: 2.4, angle: 0 });
        lamp(id, x + 0.9, h - 0.6, z + 0.6, '#5dff7a');
        box(id, x, z, 1.15, h + 0.2);
        break;
      }
      case 'page': {
        // A storefront with an awning, a glowing door and a sign plate.
        m.block(body, x, 0, z - 0.1, 2.5, h, 2.1);
        m.block(DARK, x, h, z - 0.1, 2.6, 0.18, 2.2);
        for (let index = 0; index < 5; index += 1) {
          m.add(BOX, index % 2 === 0 ? zoneColor : CREAM, x - 1.04 + index * 0.52, h * 0.7, z + 1.35, 0.52, 0.08, 1.0, -0.35, 0, 0);
        }
        lit.block(C('#ffe9a8'), x, 0.05, z + 0.96, 0.9, 1.4, 0.04);
        m.block(zoneColor, x, h + 0.18, z + 0.3, 2.2, 0.6, 0.16);
        lamp(id, x + 0.9, h * 0.55, z + 1.0, '#ffd9a0', 'night');
        box(id, x, z, 1.35, h + 0.8);
        break;
      }
      case 'config': {
        // A control cabinet with a row of indicator lamps.
        m.block(DARK, x, 0, z, 1.5, 0.15, 1.1);
        m.block(METAL, x, 0.15, z, 1.3, h, 0.9);
        m.block(zoneColor, x, 0.15 + h * 0.15, z + 0.46, 1.1, h * 0.7, 0.04);
        for (let index = 0; index < 3; index += 1) lamp(id, x - 0.35 + index * 0.35, 0.15 + h * 0.85, z + 0.5, index === 1 ? '#ffb000' : '#5dff7a', 'status', 0.7);
        box(id, x, z, 0.8, h + 0.2);
        break;
      }
      case 'doc': {
        // A notice board on two posts.
        m.block(DARK, x - 0.9, 0, z, 0.12, h, 0.12);
        m.block(DARK, x + 0.9, 0, z, 0.12, h, 0.12);
        m.block(zoneColor, x, h - 1.25, z, 2.1, 1.3, 0.1);
        m.block(CREAM, x, h - 1.18, z + 0.04, 1.9, 1.15, 0.06);
        for (let index = 0; index < 4; index += 1) m.block(C('#9aa1a9'), x - 0.2, h - 0.38 - index * 0.24, z + 0.08, 1.3 - (index % 2) * 0.4, 0.06, 0.01);
        box(id, x, z, 1.1, h + 0.1);
        break;
      }
      case 'asset': {
        // Crates: more of them for a bigger file.
        const bytes = typeof data.bytes === 'number' ? data.bytes : (entity.lines ?? 10) * 40;
        const count = bytes > 200_000 ? 3 : bytes > 20_000 ? 2 : 1;
        const tint = WOOD.clone().lerp(zoneColor, 0.25);
        m.block(tint, x - 0.4, 0, z, 0.95, 0.85, 0.95, 0.2);
        if (count > 1) m.block(tint.clone().lerp(DARK, 0.15), x + 0.6, 0, z + 0.3, 0.85, 0.8, 0.85, -0.3);
        if (count > 2) m.block(tint, x, 0.85, z + 0.1, 0.8, 0.75, 0.8, 0.5);
        box(id, x, z, 1.2, count > 2 ? 1.7 : 0.95);
        break;
      }
      case 'route': {
        // A loading dock. The door color is the HTTP method.
        const method = String(data.method ?? 'GET');
        const door = C(METHOD_COLORS[method] ?? '#ffffff');
        m.block(HAZARD, x, 0, z + 0.7, 2.3, 0.12, 1.4);
        for (let index = 0; index < 5; index += 1) m.block(DARK, x - 0.92 + index * 0.46, 0.12, z + 0.7, 0.2, 0.01, 1.4, 0.6);
        m.block(body.clone().lerp(DARK, 0.4), x, 0, z - 0.6, 2.6, h, 1.0);
        m.block(DARK, x - 1.15, 0, z + 0.05, 0.3, h, 0.3);
        m.block(DARK, x + 1.15, 0, z + 0.05, 0.3, h, 0.3);
        m.block(DARK, x, h - 0.15, z + 0.05, 2.6, 0.3, 0.3);
        m.block(door.clone().lerp(DARK, 0.25), x, 0.12, z - 0.05, 1.95, h - 0.35, 0.1);
        for (let index = 1; index < 6; index += 1) m.block(door.clone().lerp(DARK, 0.5), x, 0.12 + index * (h - 0.35) / 6, z + 0.01, 1.95, 0.04, 0.02);
        if (data.idempotencyKey === true) m.block(C('#f4f4f4'), x + 0.8, h - 0.6, z + 0.22, 0.3, 0.3, 0.04);
        lamp(id, x, h + 0.15, z + 0.1, door, 'fixed', 1.1);
        box(id, x, z, 1.35, h + 0.3);
        break;
      }
      case 'table': {
        // A silo: taller for more columns.
        const silo = C(ZONES.vault.color).lerp(STEEL, 0.55);
        m.cylinder(DARK, x, 0, z, 1.5, 0.3);
        m.cylinder(silo, x, 0.3, z, 1.25, h - 1.1);
        m.add(CONE, silo.clone().lerp(DARK, 0.15), x, h - 0.8 + 0.45, z, 2.5, 0.9, 2.5);
        for (let y = 0.9; y < h - 1; y += 1.1) m.cylinder(C(ZONES.vault.color).lerp(DARK, 0.25), x, y, z, 1.29, 0.12);
        m.block(DARK, x + 0.95, 0.3, z + 0.9, 0.1, h - 1.1, 0.1);
        m.block(DARK, x + 0.7, 0.3, z + 1.1, 0.1, h - 1.1, 0.1);
        lamp(id, x, h + 0.05, z, C(ZONES.vault.color), 'status', 1.1);
        box(id, x, z, 1.5, h + 0.2);
        break;
      }
      case 'volume': {
        // The volume: a spherical tank on legs.
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) m.block(DARK, x + dx, 0, z + dz, 0.2, 1.6, 0.2);
        m.add(SPHERE, C(ZONES.vault.color).lerp(STEEL, 0.25), x, 2.0, z, 3.0, 2.8, 3.0);
        m.cylinder(DARK, x, 1.95, z, 1.55, 0.12);
        lamp(id, x, 3.55, z, C(ZONES.vault.color), 'status', 1.2);
        box(id, x, z, 1.6, 3.5);
        break;
      }
      case 'workflow': {
        // A signal tower: one light per trigger of the workflow.
        const triggers = Array.isArray(data.triggers) ? data.triggers : [];
        m.block(DARK, x, 0, z, 1.6, 0.4, 1.6);
        m.block(METAL, x, 0.4, z, 1.1, 0.8, 1.1);
        m.cylinder(DARK, x, 1.2, z, 0.14, h - 1.2);
        triggers.forEach((trigger, index) => {
          const key = trigger.replace(/ .*$/, '');
          m.cylinder(DARK, x, 1.6 + index * 0.6, z, 0.34, 0.08);
          lamp(id, x, 1.9 + index * 0.6, z, TRIGGER_COLORS[key] ?? '#ffffff', 'fixed', 1.9);
        });
        m.block(zoneColor, x, h, z, 0.9, 0.12, 0.9);
        box(id, x, z, 0.9, h + 0.2);
        break;
      }
      case 'job': {
        // A press station: columns, a crossbeam and a press head that stamps while the job runs.
        const runsOn = String(data.runsOn ?? '');
        const runner = C(data.uses ? RUNNER_COLORS.reusable : runsOn.includes('macos') ? RUNNER_COLORS.macos : RUNNER_COLORS.ubuntu);
        m.block(DARK, x, 0, z, 2.7, 0.3, 2.4);
        m.block(HAZARD, x, 0.3, z, 1.8, 0.05, 1.8);
        m.block(runner, x - 1.1, 0.3, z, 0.36, h, 0.5);
        m.block(runner, x + 1.1, 0.3, z, 0.36, h, 0.5);
        m.block(DARK, x, h + 0.2, z, 2.7, 0.45, 0.7);
        m.block(zoneColor, x, h + 0.2, z + 0.36, 2.3, 0.3, 0.04);
        pistons.push({ id, x, z, low: 0.55, high: h - 0.2, size: 1.3, phase: Math.random() * 6 });
        lamp(id, x + 1.1, h + 0.75, z, '#5dff7a');
        box(id, x, z, 1.35, h + 0.7);
        break;
      }
      case 'stage': {
        // A shipping container, one color per Dockerfile stage.
        const name = String(entity.label.replace(/^stage /, ''));
        const color = C(STAGE_COLORS[name] ?? '#2496ed');
        m.block(color, x, 0, z, 2.7, 1.4, 1.3);
        for (let index = 0; index < 9; index += 1) m.block(color.clone().lerp(DARK, 0.3), x - 1.2 + index * 0.3, 0.05, z + 0.66, 0.06, 1.3, 0.04);
        m.block(color.clone().lerp(DARK, 0.2), x, 1.4, z, 2.4, 0.9, 1.1);
        m.block(C('#f4f4f4'), x + 0.6, 1.6, z + 0.56, 0.9, 0.45, 0.02);
        lamp(id, x - 0.9, 2.45, z, color, 'status');
        box(id, x, z, 1.4, 2.4);
        break;
      }
      case 'service': {
        // A compose service: a container under a gantry crane.
        const color = C('#2496ed');
        m.block(color, x, 0, z + 0.2, 2.4, 1.3, 1.2);
        m.block(DARK, x - 1.25, 0, z - 0.9, 0.2, 3.2, 0.2);
        m.block(DARK, x + 1.25, 0, z - 0.9, 0.2, 3.2, 0.2);
        m.block(HAZARD, x, 3.1, z - 0.9, 2.8, 0.25, 0.25);
        m.block(DARK, x, 3.1, z - 0.3, 0.25, 0.25, 1.2);
        m.block(DARK, x, 2.0, z + 0.2, 0.06, 1.1, 0.06);
        lamp(id, x + 1.25, 3.4, z - 0.9, '#ffb000', 'status');
        box(id, x, z, 1.4, 3.4);
        break;
      }
      case 'dep': {
        // Runtime packages are barrels, dev tools are crates.
        if (data.runtime === true) {
          const barrel = C('#b4472f');
          for (const [dx, dz] of [[-0.45, -0.3], [0.45, -0.3], [0, 0.45]] as const) {
            m.cylinder(barrel, x + dx, 0, z + dz, 0.42, 1.3);
            m.cylinder(DARK, x + dx, 0.3, z + dz, 0.44, 0.08);
            m.cylinder(DARK, x + dx, 1.0, z + dz, 0.44, 0.08);
          }
          box(id, x, z, 1.0, 1.4);
        } else {
          const crate = WOOD.clone().lerp(C('#c8a26b'), 0.3);
          m.block(crate, x, 0, z, 1.3, 1.0, 1.3, 0.15);
          m.block(crate.clone().lerp(DARK, 0.25), x, 0.45, z + 0.66, 1.25, 0.1, 0.02, 0.15);
          box(id, x, z, 0.9, 1.1);
        }
        break;
      }
      case 'hub':
        break;
    }
  }

  // Instanced moving parts.
  const lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), lamps.length);
  lamps.forEach(({ matrix, lamp: item }, index) => {
    lampMesh.setMatrixAt(index, matrix);
    lampMesh.setColorAt(index, item.color);
  });
  group.add(lampMesh);

  const gearGeometry = (() => {
    const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.42, 0.42, 0.14, 12)];
    for (let index = 0; index < 8; index += 1) {
      const tooth = new THREE.BoxGeometry(0.16, 0.14, 0.18);
      tooth.translate(0, 0, 0.48);
      tooth.rotateY((index / 8) * Math.PI * 2);
      parts.push(tooth);
    }
    const merged = mergeGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)), false);
    if (!merged) throw new Error('gear geometry');
    merged.rotateX(Math.PI / 2);
    return merged;
  })();
  const gearMesh = new THREE.InstancedMesh(gearGeometry, new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.8, roughness: 0.35 }), gears.length);
  gearMesh.castShadow = true;
  group.add(gearMesh);

  const fanGeometry = (() => {
    const a = new THREE.BoxGeometry(1.3, 0.05, 0.22).toNonIndexed();
    const b = new THREE.BoxGeometry(0.22, 0.05, 1.3).toNonIndexed();
    const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.14, 10).toNonIndexed();
    const merged = mergeGeometries([a, b, hub], false);
    if (!merged) throw new Error('fan geometry');
    return merged;
  })();
  const fanMesh = new THREE.InstancedMesh(fanGeometry, new THREE.MeshStandardMaterial({ color: '#d0d6dd', metalness: 0.7, roughness: 0.3 }), fans.length);
  group.add(fanMesh);

  const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(0.85, 0.09, 8, 28), new THREE.MeshStandardMaterial({ color: '#f2c230', metalness: 0.6, roughness: 0.3 }), rings.length);
  group.add(ringMesh);

  const pistonMesh = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: '#8c949e', metalness: 0.8, roughness: 0.3 }), pistons.length);
  pistonMesh.castShadow = true;
  group.add(pistonMesh);
  const rodMesh = new THREE.InstancedMesh(CYL8, new THREE.MeshStandardMaterial({ color: '#d9dee4', metalness: 0.9, roughness: 0.2 }), pistons.length);
  group.add(rodMesh);

  const droneGeometry = (() => {
    const parts = [new THREE.BoxGeometry(0.5, 0.14, 0.5).toNonIndexed()];
    for (const [dx, dz] of [[-0.38, -0.38], [0.38, -0.38], [-0.38, 0.38], [0.38, 0.38]] as const) {
      const rotor = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 12).toNonIndexed();
      rotor.translate(dx, 0.1, dz);
      const arm = new THREE.BoxGeometry(0.06, 0.05, 0.06).toNonIndexed();
      arm.translate(dx, 0.04, dz);
      parts.push(rotor, arm);
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error('drone geometry');
    return merged;
  })();
  const droneMesh = new THREE.InstancedMesh(droneGeometry, new THREE.MeshStandardMaterial({ color: '#e9f5d0', metalness: 0.4, roughness: 0.4, emissive: '#2a4410' }), drones.length);
  droneMesh.castShadow = true;
  group.add(droneMesh);

  for (const mesh of [lampMesh, gearMesh, fanMesh, ringMesh, pistonMesh, rodMesh, droneMesh]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
  }
  materials.push(gearMesh.material as THREE.Material, fanMesh.material as THREE.Material, pistonMesh.material as THREE.Material, droneMesh.material as THREE.Material);

  // Invisible pick boxes, one per entity, for the raycaster.
  const pickIds = [...bounds.keys()];
  const pick = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial(), pickIds.length);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  pickIds.forEach((id, index) => {
    const box3 = bounds.get(id);
    if (!box3) return;
    box3.getSize(size);
    box3.getCenter(center);
    pick.setMatrixAt(index, tmpMatrix.compose(center, tmpQuat.identity(), size));
  });
  pick.computeBoundingSphere();
  pick.updateMatrixWorld(true);

  const spinnerMatrix = (spinner: Spinner, extraScale = 1): THREE.Matrix4 => {
    if (spinner.axis === 'z') tmpEuler.set(0, 0, spinner.angle);
    else tmpEuler.set(0, spinner.angle, 0);
    return tmpMatrix.compose(tmpPos.set(spinner.x, spinner.y, spinner.z), tmpQuat.setFromEuler(tmpEuler), tmpScale.setScalar(spinner.scale * extraScale));
  };

  return {
    group,
    bounds,
    tops,
    hubs,
    pick,
    pickIds,
    slabs,
    posts,
    roofs,
    materials,
    update(dt, time, activity, night) {
      const boost = (id: string): number => activity.get(id) ?? 0;
      gears.forEach((gear, index) => {
        gear.angle += dt * gear.speed * (1 + boost(gear.id) * 6);
        gearMesh.setMatrixAt(index, spinnerMatrix(gear));
      });
      fans.forEach((fan, index) => {
        fan.angle += dt * fan.speed * (1 + boost(fan.id) * 4);
        fanMesh.setMatrixAt(index, spinnerMatrix(fan));
      });
      rings.forEach((ring, index) => {
        ring.angle += dt * ring.speed * (1 + boost(ring.id) * 5);
        tmpEuler.set(Math.PI / 2, 0, ring.angle);
        ringMesh.setMatrixAt(index, tmpMatrix.compose(tmpPos.set(ring.x, ring.y + Math.sin(time * 1.5 + ring.x) * 0.08, ring.z), tmpQuat.setFromEuler(tmpEuler), tmpScale.setScalar(1)));
      });
      pistons.forEach((piston, index) => {
        const busy = boost(piston.id);
        const speed = 1.4 + busy * 5;
        piston.phase += dt * speed;
        const stroke = Math.pow(Math.abs(Math.sin(piston.phase)), 3);
        const y = piston.high - (piston.high - piston.low) * stroke * (0.35 + busy * 0.65);
        pistonMesh.setMatrixAt(index, tmpMatrix.compose(tmpPos.set(piston.x, y, piston.z), tmpQuat.identity(), tmpScale.set(piston.size, 0.42, piston.size)));
        const rod = piston.high + 0.2 - y;
        rodMesh.setMatrixAt(index, tmpMatrix.compose(tmpPos.set(piston.x, y + rod / 2, piston.z), tmpQuat.identity(), tmpScale.set(0.28, rod, 0.28)));
      });
      drones.forEach((drone, index) => {
        const busy = boost(drone.id);
        const lift = 1.2 + Math.sin(time * 2 + drone.phase) * 0.18 + busy * 4;
        const orbit = busy > 0 ? time * 3 : time * 0.6 + drone.phase;
        const radius = busy > 0 ? 1.4 : 0.25;
        tmpEuler.set(0, orbit, 0);
        droneMesh.setMatrixAt(index, tmpMatrix.compose(tmpPos.set(drone.x + Math.cos(orbit) * radius, lift, drone.z + Math.sin(orbit) * radius), tmpQuat.setFromEuler(tmpEuler), tmpScale.setScalar(1)));
      });
      lamps.forEach(({ lamp: item }, index) => {
        const busy = boost(item.id);
        let level: number;
        switch (item.mode) {
          case 'night':
            level = 0.15 + night * 2.6;
            break;
          case 'fixed':
            level = 1.6 + night * 0.8;
            break;
          case 'test':
            level = 0.9 + 0.6 * Math.max(0, Math.sin(time * 1.3 + item.phase)) + night * 0.6;
            break;
          default:
            level = 1.0 + 0.35 * Math.sin(time * 2 + item.phase) + night * 0.6;
        }
        tmpColor.copy(item.color);
        if (busy > 0) tmpColor.lerp(BUSY, Math.min(1, busy)).multiplyScalar(1 + busy * 3);
        lampMesh.setColorAt(index, tmpColor.multiplyScalar(level));
      });
      for (const mesh of [gearMesh, fanMesh, ringMesh, pistonMesh, rodMesh, droneMesh]) mesh.instanceMatrix.needsUpdate = true;
      if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
    },
  };
}

export type { Entity };

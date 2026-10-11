// The land around the factory, and what it means.
// - The river along the south edge is the internet: everything that leaves the factory crosses it.
// - A canal leads from the river to the API Plant's water wheel: requests flow in from the internet and
//   turn the Node server. The sluice gate where the canal leaves the river is Caddy, the reverse proxy
//   that lets /api traffic through to the server.
// - Harbour piers send the Android and iOS apps off by ship; a railway along the bank takes Docker
//   images to the server; a highway brings npm packages in from the registry gate in the west.

import * as THREE from 'three';
import type { ZoneId } from '../../scan/model.ts';
import type { Layout, Plot } from '../layout.ts';
import type { RoadRun } from './belts.ts';
import { C, CYL, Merger, RING } from './kit.ts';
import type { Post } from './machines.ts';
import type { P2, Router } from './routes.ts';

const WATER_Y = -0.16;
const CANAL_W = 4;

export interface Landscape {
  group: THREE.Group;
  /** The river: north and south bank. */
  river: { north: number; south: number };
  /** The canal centre line, from the river to the water wheel. */
  canal: P2[];
  wheel: THREE.Vector3;
  gate: THREE.Vector3;
  /** Where ships moor, by zone. */
  berths: Map<ZoneId, THREE.Vector3>;
  rail: { z: number; station: number; east: number };
  highway: { z: number; west: number; dock: P2 };
  labels: { text: string; at: THREE.Vector3; color: string }[];
  posts: Post[];
  solids: THREE.Box3[];
  /** 0 … 1: how hard the water drives the wheel (API traffic). */
  update(dt: number, flow: number): void;
}

function waterMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.12, metalness: 0.15 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFlow;').replace(
      '#include <begin_vertex>',
      // Coordinates along and across the flow, from the instance's x axis, in world units.
      `#include <begin_vertex>
      vec4 waterWorld = vec4(transformed, 1.0);
      vec3 waterAxis = vec3(1.0, 0.0, 0.0);
      #ifdef USE_INSTANCING
        waterWorld = instanceMatrix * waterWorld;
        waterAxis = mat3(instanceMatrix) * waterAxis;
      #endif
      vec2 along = normalize(waterAxis.xz + vec2(1e-6));
      vFlow = vec2(dot(waterWorld.xz, along), dot(waterWorld.xz, vec2(-along.y, along.x)));`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vFlow;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // Soft swells and a few glints that drift downstream.
      float swell = sin(vFlow.x * 0.11 - uTime * 0.9 + sin(vFlow.y * 0.23 + vFlow.x * 0.05) * 2.0) * 0.5 + 0.5;
      float a = sin(vFlow.x * 0.9 - uTime * 2.4 + vFlow.y * 0.6);
      float b = sin(vFlow.x * 0.7 - uTime * 1.9 - vFlow.y * 0.9 + 1.7);
      float glint = smoothstep(0.97, 1.0, a * b) * smoothstep(0.45, 0.9, swell);
      vec3 deep = vec3(0.05, 0.22, 0.44);
      vec3 shallow = vec3(0.09, 0.33, 0.56);
      diffuseColor.rgb = mix(deep, shallow, swell) + glint * 0.28;`,
    );
  };
  return material;
}

export function buildLandscape(layout: Layout, router: Router, roads: RoadRun[], extent: number, time: { value: number }): Landscape {
  const group = new THREE.Group();
  const m = new Merger();
  const posts: Post[] = [];
  const solids: THREE.Box3[] = [];
  const labels: Landscape['labels'] = [];
  const plot = (zone: ZoneId): Plot => {
    const found = layout.plots.get(zone);
    if (!found) throw new Error(`no plot for ${zone}`);
    return found;
  };
  const last = router.rowRoad.length - 1;
  const southRoad = router.rowRoad[last] ?? layout.bounds.maxZ + 10;
  const north = southRoad + 10;
  const south = north + 28;
  const far = extent * 4;

  // Water: one instance per stretch, its x axis along the flow.
  const stretches: { a: P2; b: P2; width: number }[] = [];
  stretches.push({ a: { x: -far, z: (north + south) / 2 }, b: { x: far, z: (north + south) / 2 }, width: south - north });

  // The canal, from the river to the wheel south of the API Plant, through the gaps between plots.
  const api = plot('api');
  const apiRow = router.rowOf.get('api') ?? 1;
  const wheel = new THREE.Vector3(api.minX + 8, 3.2, api.maxZ + 4);
  let x = router.bestGap(last, wheel.x, wheel.x) + 4;
  const canal: P2[] = [{ x, z: north + 3 }];
  for (let row = last; row > apiRow; row -= 1) {
    const z = (router.rowRoad[row - 1] ?? 0) + 5;
    canal.push({ x, z });
    const next = row - 1 > apiRow ? router.bestGap(row - 1, x, wheel.x) + 4 : wheel.x;
    canal.push({ x: next, z });
    x = next;
  }
  canal.push({ x, z: wheel.z });
  for (let index = 1; index < canal.length; index += 1) {
    const a = canal[index - 1] as P2;
    const b = canal[index] as P2;
    // Water flows from the river toward the wheel; each stretch reaches half a canal past its ends.
    const dx = Math.sign(b.x - a.x);
    const dz = Math.sign(b.z - a.z);
    stretches.push({ a: { x: a.x - dx * (CANAL_W / 2), z: a.z - dz * (CANAL_W / 2) }, b: { x: b.x + dx * (CANAL_W / 2), z: b.z + dz * (CANAL_W / 2) }, width: CANAL_W });
  }
  const water = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.04, 1), waterMaterial(time), stretches.length);
  water.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  stretches.forEach(({ a, b, width }, index) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(b.z - a.z, b.x - a.x));
    water.setMatrixAt(index, matrix.compose(new THREE.Vector3((a.x + b.x) / 2, WATER_Y - index * 0.002, (a.z + b.z) / 2), quat, new THREE.Vector3(length, 1, width)));
  });
  group.add(water);

  // River banks: sand, with a stone edge on the canal.
  const sand = C('#d8c48f');
  m.block(sand, 0, -0.215, north - 1.2, far * 2, 0.04, 3);
  m.block(sand, 0, -0.215, south + 1.2, far * 2, 0.04, 3);
  const stone = C('#9a958a');
  for (let index = 1; index < canal.length; index += 1) {
    const a = canal[index - 1] as P2;
    const b = canal[index] as P2;
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
    const lo = alongX ? Math.min(a.x, b.x) - CANAL_W / 2 : Math.min(a.z, b.z) - CANAL_W / 2;
    const hi = alongX ? Math.max(a.x, b.x) + CANAL_W / 2 : Math.max(a.z, b.z) + CANAL_W / 2;
    for (const side of [-1, 1]) {
      const offset = side * (CANAL_W / 2 + 0.3);
      if (alongX) m.block(stone, (lo + hi) / 2, -0.22, a.z + offset, hi - lo + 0.6, 0.18, 0.6);
      else m.block(stone, a.x + offset, -0.22, (lo + hi) / 2, 0.6, 0.18, hi - lo + 0.6);
    }
  }

  // Bridges: where a road crosses the canal, railings on both sides of the road.
  const rail = C('#e3ddd0');
  for (let index = 1; index < canal.length; index += 1) {
    const a = canal[index - 1] as P2;
    const b = canal[index] as P2;
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
    const fixed = alongX ? a.z : a.x;
    const lo = alongX ? Math.min(a.x, b.x) : Math.min(a.z, b.z);
    const hi = alongX ? Math.max(a.x, b.x) : Math.max(a.z, b.z);
    for (const road of roads) {
      if ((road.axis === 'x') === alongX) continue;
      if (road.fixed < lo - 0.5 || road.fixed > hi + 0.5 || fixed < road.lo || fixed > road.hi) continue;
      for (const side of [-1.9, 1.9]) {
        const span = CANAL_W + 1.6;
        if (road.axis === 'x') {
          m.block(rail, fixed, 0, road.fixed + side, span, 0.1, 0.12);
          m.block(rail, fixed, 0.9, road.fixed + side, span, 0.1, 0.12);
          for (const end of [-1, 1]) m.block(rail, fixed + (end * span) / 2, -0.2, road.fixed + side, 0.3, 1.25, 0.3);
        } else {
          m.block(rail, road.fixed + side, 0, fixed, 0.12, 0.1, span);
          m.block(rail, road.fixed + side, 0.9, fixed, 0.12, 0.1, span);
          for (const end of [-1, 1]) m.block(rail, road.fixed + side, -0.2, fixed + (end * span) / 2, 0.3, 1.25, 0.3);
        }
      }
    }
  }

  // The sluice gate at the canal mouth: Caddy, which lets /api traffic through to the server.
  const mouth = canal[0] as P2;
  const gate = new THREE.Vector3(mouth.x, 5.5, mouth.z - 1);
  const towers = C('#8c8378');
  for (const side of [-1, 1]) {
    m.block(towers, mouth.x + side * (CANAL_W / 2 + 1.2), -0.2, mouth.z - 1, 2.2, 6.2, 2.2);
    m.block(C('#5d554c'), mouth.x + side * (CANAL_W / 2 + 1.2), 6, mouth.z - 1, 2.6, 0.5, 2.6);
    solids.push(new THREE.Box3(new THREE.Vector3(mouth.x + side * (CANAL_W / 2 + 1.2) - 1.1, 0, mouth.z - 2.1), new THREE.Vector3(mouth.x + side * (CANAL_W / 2 + 1.2) + 1.1, 6, mouth.z + 0.1)));
  }
  m.block(C('#3d4650'), mouth.x, 5, mouth.z - 1, CANAL_W + 4.6, 0.6, 0.8);
  m.block(C('#22b8a6'), mouth.x, 1.8, mouth.z - 1, CANAL_W + 0.2, 2.6, 0.25);
  for (let dx = -1.5; dx <= 1.5; dx += 1) m.block(C('#1a8c7e'), mouth.x + dx, 1.8, mouth.z - 1.15, 0.12, 2.6, 0.05);
  labels.push({ text: '🚪 Caddy gate', at: new THREE.Vector3(mouth.x, 8.5, mouth.z - 1), color: '#22b8a6' });

  // The water wheel, south of the API Plant, turning in the canal.
  for (const side of [-1, 1]) {
    m.block(C('#6b5a48'), wheel.x + side * 2.3, -0.2, wheel.z, 0.5, 4, 0.8);
    posts.push({ x: wheel.x + side * 2.3, z: wheel.z, r: 0.6, h: 4 });
  }
  const wheelGroup = new THREE.Group();
  wheelGroup.position.copy(wheel);
  const wheelParts = new Merger();
  const wood = C('#8a5a33');
  wheelParts.add(RING, wood, 0, 0, 0.7, 6, 6, 1, 0, 0, 0);
  wheelParts.add(RING, wood, 0, 0, -0.7, 6, 6, 1, 0, 0, 0);
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    wheelParts.add(new THREE.BoxGeometry(1, 1, 1), C('#9b6b3f'), Math.cos(angle) * 2.9, Math.sin(angle) * 2.9, 0, 0.9, 0.12, 1.6, 0, 0, angle);
    wheelParts.add(new THREE.BoxGeometry(1, 1, 1), wood, Math.cos(angle) * 1.5, Math.sin(angle) * 1.5, 0, 3, 0.12, 0.12, 0, 0, angle);
  }
  wheelParts.add(CYL, C('#3d3a36'), 0, 0, 0, 0.5, 2.6, 0.5, Math.PI / 2, 0, 0);
  const wheelMesh = wheelParts.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  if (wheelMesh) {
    wheelMesh.castShadow = true;
    wheelGroup.add(wheelMesh);
  }
  // The wheel turns in the canal's plane: its axle runs across the flow.
  wheelGroup.rotation.y = Math.PI / 2;
  group.add(wheelGroup);
  labels.push({ text: '⚙ Water wheel · Node server', at: new THREE.Vector3(wheel.x, 8, wheel.z), color: '#4d7cfe' });

  // Harbour piers for the app stores' ships.
  const berths = new Map<ZoneId, THREE.Vector3>();
  const plank = C('#8a6a48');
  for (const zone of ['android', 'ios'] as const) {
    const pier = plot(zone);
    const px = pier.maxX - 6;
    const z0 = southRoad + 2;
    const z1 = north + 9;
    m.block(plank, px, -0.17, (z0 + z1) / 2, 5, 0.22, z1 - z0);
    for (let z = north; z < z1; z += 3) {
      for (const side of [-2.3, 2.3]) m.add(CYL, C('#5a4632'), px + side, -0.9, z, 0.45, 1.6, 0.45);
    }
    berths.set(zone, new THREE.Vector3(px + 7, 0, z1 - 2));
  }

  // The railway along the north bank, from the container port east off the map (to the server).
  const packaging = plot('packaging');
  const railZ = southRoad + 5;
  const railWest = packaging.minX;
  const railEast = far * 0.5;
  for (let rx = railWest; rx < railEast; rx += 0.8) m.block(C('#5b4636'), rx, -0.2, railZ, 0.28, 0.12, 2.2);
  for (const dz of [-0.6, 0.6]) m.block(C('#a7adb4'), (railWest + railEast) / 2, -0.08, railZ + dz, railEast - railWest, 0.14, 0.1);
  // The station platform at the port.
  m.block(C('#b9b4a8'), (packaging.minX + packaging.maxX) / 2, -0.2, railZ - 2.4, packaging.maxX - packaging.minX, 0.7, 2.2);
  labels.push({ text: '🚂 Deploy line → server', at: new THREE.Vector3(packaging.maxX + 20, 4, railZ), color: '#2496ed' });

  // The highway from the npm registry gate in the west to the Raw Materials Dock.
  const materials = plot('materials');
  const highwayZ = router.rowRoad[0] ?? materials.maxZ + 10;
  const registry = layout.bounds.minX - 70;
  const dockX = materials.hub.x;
  m.block(C('#8b8a84'), (registry + dockX) / 2, -0.205, highwayZ, dockX - registry, 0.04, 4.6);
  m.block(C('#c9c5b9'), (registry + dockX) / 2, -0.185, highwayZ, dockX - registry, 0.04, 4.1);
  for (let hx = registry + 4; hx < dockX - 4; hx += 6) m.block(C('#f4f1ea'), hx, -0.16, highwayZ, 2.6, 0.02, 0.18);
  // The registry gate: a red arch over the highway.
  const npm = C('#cb3837');
  for (const side of [-1, 1]) {
    m.block(npm, registry + 10, -0.2, highwayZ + side * 4.2, 1.6, 9, 1.6);
    solids.push(new THREE.Box3(new THREE.Vector3(registry + 9.2, 0, highwayZ + side * 4.2 - 0.8), new THREE.Vector3(registry + 10.8, 9, highwayZ + side * 4.2 + 0.8)));
  }
  m.block(npm, registry + 10, 8.8, highwayZ, 1.8, 2.2, 10.2);
  labels.push({ text: '📦 npm registry', at: new THREE.Vector3(registry + 10, 12.5, highwayZ), color: '#cb3837' });
  labels.push({ text: '🌐 The internet', at: new THREE.Vector3(0, 3, (north + south) / 2), color: '#5aa9e6' });

  const mesh = m.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }));
  if (mesh) {
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }

  return {
    group,
    river: { north, south },
    canal,
    wheel,
    gate,
    berths,
    rail: { z: railZ, station: (packaging.minX + packaging.maxX) / 2, east: railEast },
    highway: { z: highwayZ, west: registry, dock: { x: dockX, z: materials.maxZ + 1 } },
    labels,
    posts,
    solids,
    update(dt, flow) {
      wheelGroup.rotation.x -= dt * (0.25 + flow * 1.6);
    },
  };
}

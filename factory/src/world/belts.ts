// Conveyor belts and the items on them. Inside a zone a belt leaves a machine into the aisle below its
// row, runs along the aisles, and enters its target from the east. Between zones, belts run to the zone
// hub, then over an elevated trunk line on the road, then down to the other hub. Items travel the
// whole path, so a moving item is one real import (or package, COPY, job dependency…) at work.

import * as THREE from 'three';
import type { Edge, FactoryModel, ZoneId } from '../../scan/model.ts';
import type { Layout } from '../layout.ts';
import { EDGES, ZONES } from '../lore.ts';

const BELT_Y = 0.3;
const TRUNK_Y = 8.6;

interface Path {
  edge: number;
  points: THREE.Vector3[];
  lengths: number[];
  total: number;
}

interface Segment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  width: number;
  edges: number[];
}

interface Item {
  path: Path;
  distance: number;
  speed: number;
}

export type BeltMode = 'all' | 'selected' | 'off';

export interface BeltFilter {
  mode: BeltMode;
  focus: Set<string> | null;
  typeOnly: boolean;
}

export interface Belts {
  group: THREE.Group;
  /** The belt route between two entities, when an edge joins them, in travel order a → b. */
  routeBetween(a: string, b: string): THREE.Vector3[] | undefined;
  setFilter(filter: BeltFilter): void;
  update(dt: number): void;
  counts: { belts: number; items: number; edges: number };
}

function hash(value: number): number {
  const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function measure(points: THREE.Vector3[]): { lengths: number[]; total: number } {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    lengths.push((lengths[index - 1] ?? 0) + (a && b ? a.distanceTo(b) : 0));
  }
  return { lengths, total: lengths[lengths.length - 1] ?? 0 };
}

function dedupe(points: THREE.Vector3[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last.distanceToSquared(point) > 1e-4) out.push(point);
  }
  return out;
}

function sample(path: Path, distance: number, out: THREE.Vector3): THREE.Vector3 {
  const { points, lengths } = path;
  let index = 1;
  while (index < lengths.length - 1 && (lengths[index] ?? 0) < distance) index += 1;
  const a = points[index - 1];
  const b = points[index];
  if (!a || !b) return out.copy(points[0] ?? out);
  const start = lengths[index - 1] ?? 0;
  const span = (lengths[index] ?? 0) - start;
  return out.copy(a).lerp(b, span > 0 ? (distance - start) / span : 0);
}

const beltMaterial = (time: { value: number }): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, metalness: 0.35 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vBelt;\nvarying float vSide;\nvarying float vTop;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vBelt = position.x * length(instanceMatrix[0].xyz);
        #else
          vBelt = position.x;
        #endif
        vSide = position.z;
        vTop = normal.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vBelt;\nvarying float vSide;\nvarying float vTop;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lane = step(abs(vSide), 0.34);
        float chevron = step(0.55, fract(vBelt * 1.25 - abs(vSide) * 1.1 - uTime * 1.5));
        float top = step(0.5, vTop);
        vec3 tint = diffuseColor.rgb;
        diffuseColor.rgb = mix(vec3(0.09, 0.1, 0.11), tint * 0.55, 0.65);
        diffuseColor.rgb = mix(diffuseColor.rgb, tint * 1.1, chevron * lane * top);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.66, 0.12), (1.0 - lane) * 0.85);`,
      );
  };
  return material;
};

export function buildBelts(model: FactoryModel, layout: Layout, hubs: Map<ZoneId, THREE.Vector3>, time: { value: number }): Belts {
  const group = new THREE.Group();
  const edges: Edge[] = [];
  const paths: Path[] = [];
  const segments = new Map<string, Segment>();
  const pairs = new Map<string, { index: number; count: number }>();

  const skip = (id: string): boolean => {
    const place = layout.places.get(id);
    return !place || place.entity.kind === 'test';
  };

  // Count trunk traffic first: trunk width shows how much flows between two zones.
  for (const edge of model.edges) {
    if (skip(edge.from) || skip(edge.to)) continue;
    const a = layout.places.get(edge.from)?.entity.zone;
    const b = layout.places.get(edge.to)?.entity.zone;
    if (!a || !b || a === b) continue;
    const key = `${a}>${b}`;
    const pair = pairs.get(key) ?? { index: pairs.size, count: 0 };
    pair.count += 1;
    pairs.set(key, pair);
  }

  const addSegment = (a: THREE.Vector3, b: THREE.Vector3, width: number, edge: number): void => {
    if (a.distanceToSquared(b) < 1e-4) return;
    const key = `${a.x.toFixed(2)},${a.y.toFixed(2)},${a.z.toFixed(2)}>${b.x.toFixed(2)},${b.y.toFixed(2)},${b.z.toFixed(2)}`;
    const segment = segments.get(key) ?? { a, b, width, edges: [] };
    segment.edges.push(edge);
    segments.set(key, segment);
  };

  model.edges.forEach((edge) => {
    if (skip(edge.from) || skip(edge.to)) return;
    const from = layout.places.get(edge.from);
    const to = layout.places.get(edge.to);
    if (!from || !to) return;
    const index = edges.length;
    edges.push(edge);
    const y = BELT_Y + (index % 3) * 0.04;
    const laneOut = 1.55 + hash(index) * 1.05;
    const laneIn = 1.55 + hash(index + 0.5) * 1.05;
    const out = (x: number, z: number, ax: number, az: number, tx: number, tz: number): THREE.Vector3[] => [
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(x, y, az),
      new THREE.Vector3(ax, y, az),
      new THREE.Vector3(ax, y, tz),
      new THREE.Vector3(tx, y, tz),
    ];
    const sameZone = from.entity.zone === to.entity.zone;
    let parts: { points: THREE.Vector3[]; width: number }[];
    if (sameZone) {
      parts = [{ points: out(from.x, from.z, to.x + laneIn, from.z + laneOut, to.x, to.z), width: 0.42 }];
    } else {
      const hubA = hubs.get(from.entity.zone);
      const hubB = hubs.get(to.entity.zone);
      const plotA = layout.plots.get(from.entity.zone);
      const pair = pairs.get(`${from.entity.zone}>${to.entity.zone}`);
      if (!hubA || !hubB || !plotA || !pair) return;
      const k = pair.index;
      const trunkY = TRUNK_Y + (k % 8) * 0.7;
      const road = plotA.maxZ + 3.5 + (k % 8) * 1.45;
      const offA = ((k % 5) - 2) * 0.45;
      const offB = (((k + 2) % 5) - 2) * 0.45;
      const trunkWidth = 0.5 + Math.min(1.3, Math.log2(pair.count + 1) * 0.28);
      parts = [
        // Machine → own hub, along the aisles.
        { points: out(from.x, from.z, hubA.x, from.z + laneOut, hubA.x, hubA.z), width: 0.42 },
        // Hub → hub over the trunk line.
        {
          points: [
            new THREE.Vector3(hubA.x, y, hubA.z),
            new THREE.Vector3(hubA.x + offA, y, hubA.z),
            new THREE.Vector3(hubA.x + offA, trunkY, hubA.z),
            new THREE.Vector3(hubA.x + offA, trunkY, road),
            new THREE.Vector3(hubB.x + offB, trunkY, road),
            new THREE.Vector3(hubB.x + offB, trunkY, hubB.z),
            new THREE.Vector3(hubB.x + offB, y, hubB.z),
            new THREE.Vector3(hubB.x, y, hubB.z),
          ],
          width: trunkWidth,
        },
        // Other hub → target machine, along the walkway and the aisles.
        { points: out(hubB.x, hubB.z, to.x + laneIn, hubB.z, to.x, to.z), width: 0.42 },
      ];
    }
    const all: THREE.Vector3[] = [];
    for (const part of parts) {
      const points = dedupe(part.points);
      for (let p = 1; p < points.length; p += 1) {
        const a = points[p - 1];
        const b = points[p];
        if (a && b) addSegment(a, b, part.width, index);
      }
      all.push(...points);
    }
    const points = dedupe(all);
    paths.push({ edge: index, points, ...measure(points) });
  });

  // Belts.
  const segmentList = [...segments.values()];
  const beltMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 1), beltMaterial(time), segmentList.length);
  beltMesh.receiveShadow = true;
  beltMesh.frustumCulled = false;
  group.add(beltMesh);

  // Pillars under the elevated trunk segments.
  const pillarSpots: THREE.Vector3[] = [];
  const pillarOf: number[][] = segmentList.map(() => []);
  segmentList.forEach((segment, index) => {
    if (segment.a.y < 2 || Math.abs(segment.a.y - segment.b.y) > 0.01) return;
    const length = segment.a.distanceTo(segment.b);
    for (let d = 4; d < length - 2; d += 11) {
      pillarOf[index]?.push(pillarSpots.length);
      pillarSpots.push(segment.a.clone().lerp(segment.b, d / length));
    }
  });
  const pillarMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.22, 1, 8), new THREE.MeshStandardMaterial({ color: '#59616b', metalness: 0.6, roughness: 0.5 }), pillarSpots.length);
  pillarMesh.castShadow = true;
  pillarMesh.frustumCulled = false;
  group.add(pillarMesh);

  // Items.
  const items: Item[] = [];
  const itemsOf: number[][] = edges.map(() => []);
  for (const path of paths) {
    const edge = edges[path.edge];
    if (!edge || edge.typeOnly) continue;
    const count = Math.min(4, Math.max(1, Math.round(path.total / 22)));
    for (let n = 0; n < count; n += 1) {
      itemsOf[path.edge]?.push(items.length);
      items.push({ path, distance: (path.total * (n + hash(path.edge * 7 + n))) / count, speed: 2.2 + hash(path.edge * 3) * 0.8 });
    }
  }
  const itemMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.3, 0.34), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }), items.length);
  itemMesh.castShadow = true;
  itemMesh.frustumCulled = false;
  itemMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(itemMesh);

  const edgeColor = (edge: Edge): THREE.Color => {
    if (edge.kind === 'import') {
      const zone = layout.places.get(edge.from)?.entity.zone;
      return new THREE.Color(zone ? ZONES[zone].color : '#cccccc');
    }
    return new THREE.Color(EDGES[edge.kind].color);
  };
  const BLUEPRINT = new THREE.Color('#3f6fb8');
  const GREY = new THREE.Color('#9aa1aa');

  const visibleItems: number[] = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const color = new THREE.Color();

  function setFilter(filter: BeltFilter): void {
    const shown = edges.map((edge) => {
      if (filter.mode === 'off') return 0;
      if (edge.typeOnly && !filter.typeOnly) return 0;
      const touches = filter.focus !== null && (filter.focus.has(edge.from) || filter.focus.has(edge.to));
      if (filter.mode === 'selected') return touches ? 2 : 0;
      if (filter.focus === null) return 1;
      return touches ? 2 : 0.5;
    });
    let count = 0;
    segmentList.forEach((segment, index) => {
      let level = 0;
      let lead = -1;
      for (const edge of segment.edges) {
        const value = shown[edge] ?? 0;
        if (value > level) {
          level = value;
          lead = edge;
        }
      }
      const pillars = pillarOf[index] ?? [];
      const visible = level > 0;
      for (const pillar of pillars) {
        const spot = pillarSpots[pillar];
        if (!spot) continue;
        pillarMesh.setMatrixAt(pillar, matrix.compose(pos.set(spot.x, spot.y / 2, spot.z), quat.identity(), scale.set(1, visible ? spot.y - 0.05 : 0, 1)));
      }
      if (!visible || lead < 0) return;
      const edge = edges[lead];
      if (!edge) return;
      const { a, b, width } = segment;
      dir.subVectors(b, a);
      const length = dir.length();
      dir.normalize();
      quat.setFromUnitVectors(X, dir);
      pos.addVectors(a, b).multiplyScalar(0.5);
      const vertical = Math.abs(dir.y) > 0.9;
      beltMesh.setMatrixAt(count, matrix.compose(pos, quat, scale.set(length + (vertical ? 0 : width), vertical ? 0.16 : 0.1, width)));
      if (edge.typeOnly) color.copy(BLUEPRINT);
      else if (level === 1 && segment.width < 0.45) color.copy(GREY).lerp(edgeColor(edge), 0.35);
      else color.copy(edgeColor(edge));
      if (level === 0.5) color.multiplyScalar(0.28);
      if (level === 2) color.multiplyScalar(1.35);
      beltMesh.setColorAt(count, color);
      count += 1;
    });
    beltMesh.count = count;
    beltMesh.instanceMatrix.needsUpdate = true;
    if (beltMesh.instanceColor) beltMesh.instanceColor.needsUpdate = true;
    pillarMesh.instanceMatrix.needsUpdate = true;

    visibleItems.length = 0;
    edges.forEach((edge, index) => {
      const level = shown[index] ?? 0;
      if (level === 0 || level === 0.5) return;
      for (const item of itemsOf[index] ?? []) {
        itemMesh.setColorAt(visibleItems.length, color.copy(edgeColor(edge)).multiplyScalar(level === 2 ? 1.6 : 1));
        visibleItems.push(item);
      }
    });
    itemMesh.count = visibleItems.length;
    if (itemMesh.instanceColor) itemMesh.instanceColor.needsUpdate = true;
    counts.belts = count;
    counts.items = visibleItems.length;
  }

  const counts = { belts: segmentList.length, items: items.length, edges: edges.length };

  // Routes between two entities, for scenario packets that follow real belts.
  const byPair = new Map<string, Path>();
  for (const path of paths) {
    const edge = edges[path.edge];
    if (edge) byPair.set(`${edge.from}\u0000${edge.to}`, path);
  }

  setFilter({ mode: 'all', focus: null, typeOnly: true });

  return {
    group,
    counts,
    setFilter,
    routeBetween(a, b) {
      const forward = byPair.get(`${a}\u0000${b}`);
      if (forward) return forward.points.map((point) => point.clone());
      const backward = byPair.get(`${b}\u0000${a}`);
      if (backward) return backward.points.map((point) => point.clone()).reverse();
      return undefined;
    },
    update(dt) {
      visibleItems.forEach((itemIndex, slot) => {
        const item = items[itemIndex];
        if (!item) return;
        item.distance = (item.distance + dt * item.speed) % item.path.total;
        sample(item.path, item.distance, pos);
        pos.y += 0.2;
        itemMesh.setMatrixAt(slot, matrix.compose(pos, quat.identity(), scale.setScalar(1)));
      });
      itemMesh.instanceMatrix.needsUpdate = true;
    },
  };
}

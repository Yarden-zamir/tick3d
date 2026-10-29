// Conveyor belts and the items on them. Belts follow fixed lanes, like a real factory floor: inside a
// zone a belt drops from its machine into the aisle below its row, runs along the aisles, and enters its
// target from the east. Between zones it runs to the zone hub, out onto the paved road south of its row,
// through the gaps between plots, and up into the other hub. Traffic keeps right, so an aisle or a road
// carries at most two lanes, one per direction, and every import that shares a lane shares one belt.
// Items travel the whole path, so a moving item is one real import (or package, COPY, job dependency…).

import * as THREE from 'three';
import type { Edge, FactoryModel } from '../../scan/model.ts';
import type { Layout } from '../layout.ts';
import { EDGES, ZONES } from '../lore.ts';
import { type LaneClass, type P2, type Router, near, offsetPath, simplify } from './routes.ts';

const BELT_Y = 0.3;
const BELT_T = 0.16;
const ITEM_Y = BELT_Y + BELT_T / 2 + 0.15;
const ROAD_W = 3.4;

const LANE: Record<LaneClass, { offset: number; width: number }> = {
  aisle: { offset: 0.34, width: 0.5 },
  road: { offset: 0.6, width: 0.82 },
};

// Draw order where lanes overlap: a later state sits on top. Lanes along z sit a hair above lanes along
// x, so corners never flicker.
const STATES = ['dim', 'type', 'normal', 'in', 'out'] as const;
type State = (typeof STATES)[number];
const STATE_COLORS: Record<State, THREE.Color> = {
  dim: new THREE.Color('#6d7379'),
  type: new THREE.Color('#7ea4dc'),
  normal: new THREE.Color('#c3c9cf'),
  in: new THREE.Color('#38b6ff'),
  out: new THREE.Color('#ff9326'),
};
export const BELT_COLORS = { normal: '#c3c9cf', type: '#7ea4dc', in: '#38b6ff', out: '#ff9326' };

interface Path {
  edge: number;
  points: THREE.Vector3[];
  lengths: number[];
  total: number;
}

/** One stretch of one edge on one lane. A lane is an axis, a fixed coordinate and a direction. */
interface Span {
  edge: number;
  lo: number;
  hi: number;
}

interface Lane {
  cls: LaneClass;
  axis: 'x' | 'z';
  fixed: number;
  sign: 1 | -1;
  spans: Span[];
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

/** A paved stretch of road: along an axis at a fixed coordinate, from lo to hi. */
export interface RoadRun {
  axis: 'x' | 'z';
  fixed: number;
  lo: number;
  hi: number;
}

/** Edges that travel some other way than on a belt: as fluid in pipes, or by tube or cable car. */
export function onBelt(edge: Edge, kindOf: (id: string) => string | undefined): boolean {
  if (edge.kind === 'calls' || edge.kind === 'message' || edge.kind === 'stores') return false;
  if (edge.kind === 'serves' && kindOf(edge.to) === 'volume') return false;
  return kindOf(edge.from) !== 'style';
}

export interface Belts {
  group: THREE.Group;
  roads: RoadRun[];
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
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.25 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vBelt;\nvarying float vSide;\nvarying float vTop;')
      .replace(
        '#include <begin_vertex>',
        // The arrow pattern runs in world space along the travel direction, so belts that overlap on one
        // lane paint the very same pixels.
        `#include <begin_vertex>
        vec4 beltWorld = vec4(transformed, 1.0);
        vec3 beltAxis = vec3(1.0, 0.0, 0.0);
        #ifdef USE_INSTANCING
          beltWorld = instanceMatrix * beltWorld;
          beltAxis = mat3(instanceMatrix) * beltAxis;
        #endif
        beltWorld = modelMatrix * beltWorld;
        vBelt = dot(beltWorld.xz, normalize(beltAxis.xz + vec2(1e-6)));
        vSide = position.z;
        vTop = normal.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vBelt;\nvarying float vSide;\nvarying float vTop;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lane = step(abs(vSide), 0.36) * step(0.5, vTop);
        float arrow = step(0.62, fract(vBelt * 0.8 - abs(vSide) * 0.9 - uTime * 1.3));
        vec3 tint = diffuseColor.rgb;
        vec3 rubber = vec3(0.13, 0.14, 0.15);
        vec3 surface = mix(rubber, tint * 0.95, arrow * 0.8);
        diffuseColor.rgb = mix(tint * 0.78, surface, lane);`,
      );
  };
  return material;
};

export function buildBelts(model: FactoryModel, layout: Layout, router: Router, time: { value: number }): Belts {
  const group = new THREE.Group();
  const edges: Edge[] = [];
  const paths: Path[] = [];
  const lanes = new Map<string, Lane>();
  const roads = new Map<string, { axis: 'x' | 'z'; fixed: number; spans: [number, number][] }>();

  const kindOf = (id: string): string | undefined => layout.places.get(id)?.entity.kind;
  const skip = (id: string): boolean => {
    const place = layout.places.get(id);
    return !place || place.entity.kind === 'test';
  };

  const addSpan = (cls: LaneClass, a: P2, b: P2, edge: number): void => {
    const axis = near(a.z, b.z) ? 'x' : 'z';
    const from = axis === 'x' ? a.x : a.z;
    const to = axis === 'x' ? b.x : b.z;
    if (near(from, to)) return;
    const fixed = axis === 'x' ? a.z : a.x;
    const sign = to > from ? 1 : -1;
    const key = `${cls}|${axis}|${fixed.toFixed(2)}|${sign}`;
    const lane = lanes.get(key) ?? { cls, axis, fixed, sign, spans: [] };
    // Reach past each end by half a belt, so lanes meet cleanly at corners.
    const reach = LANE[cls].width / 2;
    lane.spans.push({ edge, lo: Math.min(from, to) - reach, hi: Math.max(from, to) + reach });
    lanes.set(key, lane);
  };

  const addRoad = (a: P2, b: P2): void => {
    const axis = near(a.z, b.z) ? 'x' : 'z';
    const fixed = axis === 'x' ? a.z : a.x;
    const from = axis === 'x' ? a.x : a.z;
    const to = axis === 'x' ? b.x : b.z;
    const key = `${axis}|${fixed.toFixed(2)}`;
    const road = roads.get(key) ?? { axis, fixed, spans: [] };
    road.spans.push([Math.min(from, to) - ROAD_W / 2, Math.max(from, to) + ROAD_W / 2]);
    roads.set(key, road);
  };

  model.edges.forEach((edge) => {
    if (skip(edge.from) || skip(edge.to) || !onBelt(edge, kindOf)) return;
    const parts = router.route(edge.from, edge.to);
    if (!parts) return;
    const index = edges.length;
    edges.push(edge);
    const all: THREE.Vector3[] = [];
    for (const part of parts) {
      const centre = simplify(part.points);
      const lane = offsetPath(centre, LANE[part.cls].offset);
      for (let p = 1; p < lane.length; p += 1) {
        const a = lane[p - 1];
        const b = lane[p];
        if (a && b) addSpan(part.cls, a, b, index);
      }
      if (part.cls === 'road') {
        for (let p = 1; p < centre.length; p += 1) {
          const a = centre[p - 1];
          const b = centre[p];
          if (a && b) addRoad(a, b);
        }
      }
      for (const point of lane) all.push(new THREE.Vector3(point.x, ITEM_Y, point.z));
    }
    const points = all.filter((point, p) => p === 0 || point.distanceToSquared(all[p - 1] as THREE.Vector3) > 1e-4);
    paths.push({ edge: index, points, ...measure(points) });
  });

  const laneList = [...lanes.values()];
  const spanCount = laneList.reduce((sum, lane) => sum + lane.spans.length, 0);

  // Paved roads under the road belts, with a darker curb. They never change, so they are built once.
  const unite = (spans: [number, number][]): [number, number][] => {
    const sorted = [...spans].sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const span of sorted) {
      const last = out[out.length - 1];
      if (last && span[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], span[1]);
      else out.push([span[0], span[1]]);
    }
    return out;
  };
  const roadRuns = [...roads.values()].flatMap((road) => unite(road.spans).map(([lo, hi]) => ({ road, lo, hi })));
  const roadList: RoadRun[] = roadRuns.map(({ road, lo, hi }) => ({ axis: road.axis, fixed: road.fixed, lo, hi }));
  const pavement = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.95 }), roadRuns.length * 2);
  pavement.receiveShadow = true;
  const curb = new THREE.Color('#8b8a84');
  const paving = new THREE.Color('#c9c5b9');
  {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const size = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    roadRuns.forEach(({ road, lo, hi }, index) => {
      const mid = (lo + hi) / 2;
      const length = hi - lo;
      for (const [slot, width, y, color] of [
        [index * 2, ROAD_W + 0.5, -0.205, curb],
        [index * 2 + 1, ROAD_W, -0.185, paving],
      ] as const) {
        if (road.axis === 'x') {
          position.set(mid, y, road.fixed);
          size.set(length + 0.5, 0.04, width);
        } else {
          position.set(road.fixed, y, mid);
          size.set(width, 0.04, length + 0.5);
        }
        pavement.setMatrixAt(slot, matrix.compose(position, quaternion, size));
        pavement.setColorAt(slot, color);
      }
    });
  }
  group.add(pavement);

  // Belts: one box per unbroken run of a lane in one state.
  const beltMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), beltMaterial(time), Math.max(1, spanCount));
  beltMesh.receiveShadow = true;
  beltMesh.castShadow = true;
  beltMesh.frustumCulled = false;
  group.add(beltMesh);

  // Items.
  const items: Item[] = [];
  const itemsOf: number[][] = edges.map(() => []);
  for (const path of paths) {
    const edge = edges[path.edge];
    if (!edge || edge.typeOnly) continue;
    const count = Math.min(4, Math.max(1, Math.round(path.total / 26)));
    for (let n = 0; n < count; n += 1) {
      itemsOf[path.edge]?.push(items.length);
      items.push({ path, distance: (path.total * (n + hash(path.edge * 7 + n))) / count, speed: 2.4 + hash(path.edge * 3) * 0.6 });
    }
  }
  const itemMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.26, 0.3), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), Math.max(1, items.length));
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

  const visibleItems: number[] = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const color = new THREE.Color();
  const X = new THREE.Vector3(1, 0, 0);
  const travel = new THREE.Vector3();

  function setFilter(filter: BeltFilter): void {
    const stateOf = edges.map((edge): State | null => {
      if (filter.mode === 'off') return null;
      if (edge.typeOnly && !filter.typeOnly) return null;
      const out = filter.focus?.has(edge.from) ?? false;
      const into = filter.focus?.has(edge.to) ?? false;
      if (filter.mode === 'selected' && !out && !into) return null;
      if (out) return 'out';
      if (into) return 'in';
      if (filter.focus !== null) return 'dim';
      return edge.typeOnly ? 'type' : 'normal';
    });

    let count = 0;
    for (const lane of laneList) {
      const byState = new Map<State, [number, number][]>();
      for (const span of lane.spans) {
        const state = stateOf[span.edge];
        if (!state) continue;
        byState.set(state, [...(byState.get(state) ?? []), [span.lo, span.hi]]);
      }
      const { width } = LANE[lane.cls];
      travel.set(lane.axis === 'x' ? lane.sign : 0, 0, lane.axis === 'z' ? lane.sign : 0);
      quat.setFromUnitVectors(X, travel);
      for (const [state, spans] of byState) {
        const rank = STATES.indexOf(state);
        const y = BELT_Y + rank * 0.006 + (lane.axis === 'z' ? 0.003 : 0) + (rank >= 3 ? 0.02 : 0);
        for (const [lo, hi] of unite(spans)) {
          const mid = (lo + hi) / 2;
          if (lane.axis === 'x') pos.set(mid, y, lane.fixed);
          else pos.set(lane.fixed, y, mid);
          beltMesh.setMatrixAt(count, matrix.compose(pos, quat, scale.set(hi - lo, BELT_T, width)));
          beltMesh.setColorAt(count, STATE_COLORS[state]);
          count += 1;
        }
      }
    }
    beltMesh.count = count;
    beltMesh.instanceMatrix.needsUpdate = true;
    if (beltMesh.instanceColor) beltMesh.instanceColor.needsUpdate = true;

    visibleItems.length = 0;
    edges.forEach((edge, index) => {
      const state = stateOf[index];
      if (!state || state === 'dim') return;
      const focused = state === 'in' || state === 'out';
      for (const item of itemsOf[index] ?? []) {
        itemMesh.setColorAt(visibleItems.length, color.copy(edgeColor(edge)).multiplyScalar(focused ? 1.5 : 1));
        visibleItems.push(item);
      }
    });
    itemMesh.count = visibleItems.length;
    if (itemMesh.instanceColor) itemMesh.instanceColor.needsUpdate = true;
    counts.belts = count;
    counts.items = visibleItems.length;
  }

  const counts = { belts: spanCount, items: items.length, edges: edges.length };

  // Routes between two entities, for scenario packets that follow real belts.
  const byPair = new Map<string, Path>();
  for (const path of paths) {
    const edge = edges[path.edge];
    if (edge) byPair.set(`${edge.from}\u0000${edge.to}`, path);
  }

  setFilter({ mode: 'all', focus: null, typeOnly: true });

  return {
    group,
    roads: roadList,
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
      quat.identity();
      scale.setScalar(1);
      visibleItems.forEach((itemIndex, slot) => {
        const item = items[itemIndex];
        if (!item) return;
        item.distance = (item.distance + dt * item.speed) % item.path.total;
        sample(item.path, item.distance, pos);
        itemMesh.setMatrixAt(slot, matrix.compose(pos, quat, scale));
      });
      itemMesh.instanceMatrix.needsUpdate = true;
    },
  };
}

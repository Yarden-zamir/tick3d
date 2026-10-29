// Pipes carry what flows rather than what is carried in pieces: rows streaming into the DuckDB tables,
// CSS (paint, one color per stylesheet) into the pages and modules that load it, and the Docker volume
// that holds the database. HTTP calls ride pneumatic tubes: one capsule is one request, from the client
// code that makes it to the route's loading dock. The event stream (SSE) is a glass pipe that flows the
// other way, from the API back to the client, without stopping.
// Pipes follow the same aisles and roads as the belts, on a rack above them, one height per kind.

import * as THREE from 'three';
import type { Edge, FactoryModel } from '../../scan/model.ts';
import type { Layout } from '../layout.ts';
import { type Router, offsetPath, simplify } from './routes.ts';

export type Fluid = 'stores' | 'paint' | 'volume' | 'stream' | 'tube';

export const FLUIDS: Record<Fluid, { name: string; y: number; r: number; color: string; meaning: string }> = {
  stores: { name: 'Table pipe', y: 2.3, r: 0.17, color: '#18b7a0', meaning: 'server/store.ts writes rows into each DuckDB table: they flow into the silos.' },
  paint: { name: 'Paint pipe', y: 2.8, r: 0.13, color: '#ff6fb5', meaning: 'A stylesheet flows into the page or module that loads it. Each stylesheet has its own paint color.' },
  volume: { name: 'Data pipe', y: 3.4, r: 0.22, color: '#2496ed', meaning: 'The API container mounts the Docker volume that holds the DuckDB file.' },
  stream: { name: 'Event stream', y: 4.0, r: 0.16, color: '#ffd23f', meaning: 'The SSE stream (new EventSource) flows from the API back to the client, without stopping.' },
  tube: { name: 'Pneumatic tube', y: 4.7, r: 0.24, color: '#cfe8ff', meaning: 'The client code’s HTTP calls. Each capsule is one request on its way to the route’s loading dock.' },
};

const LANE = { aisle: 0.34, road: 0.6 };

interface PipePath {
  edge: Edge;
  fluid: Fluid;
  color: THREE.Color;
  points: THREE.Vector3[];
  lengths: number[];
  total: number;
}

interface Capsule {
  path: PipePath;
  distance: number;
  color: THREE.Color;
  done: () => void;
}

export interface Pipes {
  group: THREE.Group;
  /** Send one request capsule from the calling code to this route; resolves when it arrives. */
  sendCapsule(routeId: string, color: string): Promise<void> | undefined;
  /** The client file that calls a route, if any. */
  callerOf(routeId: string): string | undefined;
  /** The pipe or tube route between two entities, in travel order a → b. */
  routeBetween(a: string, b: string): THREE.Vector3[] | undefined;
  paths: PipePath[];
  update(dt: number): void;
}

/** The fluid of an edge that travels in a pipe, or undefined for one that rides a belt. */
export function fluidOf(edge: Edge, kindOf: (id: string) => string | undefined): Fluid | undefined {
  if (edge.kind === 'stores') return 'stores';
  if (edge.kind === 'calls') return edge.stream ? 'stream' : 'tube';
  if (edge.kind === 'serves' && kindOf(edge.to) === 'volume') return 'volume';
  if (edge.kind !== 'message' && kindOf(edge.from) === 'style') return 'paint';
  return undefined;
}

function measure(points: THREE.Vector3[]): { lengths: number[]; total: number } {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) lengths.push((lengths[index - 1] ?? 0) + (points[index - 1] as THREE.Vector3).distanceTo(points[index] as THREE.Vector3));
  return { lengths, total: lengths[lengths.length - 1] ?? 0 };
}

function sample(path: PipePath, distance: number, out: THREE.Vector3): THREE.Vector3 {
  const { points, lengths } = path;
  let index = 1;
  while (index < lengths.length - 1 && (lengths[index] ?? 0) < distance) index += 1;
  const a = points[index - 1] as THREE.Vector3;
  const b = points[index] as THREE.Vector3;
  const start = lengths[index - 1] ?? 0;
  const span = (lengths[index] ?? 0) - start;
  return out.copy(a).lerp(b, span > 0 ? (distance - start) / span : 0);
}

/** Bands that move along the pipe in world space, so pipes that overlap paint the same pixels. */
function flowMaterial(time: { value: number }, options: THREE.MeshStandardMaterialParameters, speed: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial(options);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vFlow;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 pipeWorld = vec4(transformed, 1.0);
      vec3 pipeAxis = vec3(0.0, 1.0, 0.0);
      #ifdef USE_INSTANCING
        pipeWorld = instanceMatrix * pipeWorld;
        pipeAxis = mat3(instanceMatrix) * pipeAxis;
      #endif
      pipeWorld = modelMatrix * pipeWorld;
      vFlow = dot(pipeWorld.xyz, normalize(pipeAxis));`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vFlow;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float band = smoothstep(0.7, 0.95, fract(vFlow * 0.45 - uTime * ${speed.toFixed(2)}));
      diffuseColor.rgb = mix(diffuseColor.rgb * 0.62, diffuseColor.rgb * 1.25 + 0.08, band);`,
    );
  };
  return material;
}

export function buildPipes(model: FactoryModel, layout: Layout, router: Router, time: { value: number }): Pipes {
  const group = new THREE.Group();
  const kindOf = (id: string): string | undefined => layout.places.get(id)?.entity.kind;
  const paths: PipePath[] = [];

  // One paint color per stylesheet.
  const styles = [...new Set(model.edges.filter((edge) => fluidOf(edge, kindOf) === 'paint').map((edge) => edge.from))].sort();
  const paintColor = (id: string): THREE.Color => new THREE.Color().setHSL((styles.indexOf(id) * 0.21 + 0.88) % 1, 0.75, 0.6);

  for (const edge of model.edges) {
    const fluid = fluidOf(edge, kindOf);
    if (!fluid) continue;
    // The event stream flows from the route back to the client.
    const [from, to] = fluid === 'stream' ? [edge.to, edge.from] : [edge.from, edge.to];
    const parts = router.route(from, to);
    if (!parts) continue;
    const lift = fluid === 'paint' ? (styles.indexOf(edge.from) % 4) * 0.32 : 0;
    const y = FLUIDS[fluid].y + lift;
    const points: THREE.Vector3[] = [];
    for (const part of parts) for (const point of offsetPath(simplify(part.points), LANE[part.cls])) points.push(new THREE.Vector3(point.x, y, point.z));
    // Risers: down to the top of a machine lower than the pipe.
    const start = layout.places.get(from);
    const end = layout.places.get(to);
    const first = points[0];
    const last = points[points.length - 1];
    if (start && first && start.h < y - 0.3) points.unshift(new THREE.Vector3(first.x, start.h, first.z));
    if (end && last && end.h < y - 0.3) points.push(new THREE.Vector3(last.x, end.h, last.z));
    const clean = points.filter((point, index) => index === 0 || point.distanceToSquared(points[index - 1] as THREE.Vector3) > 1e-4);
    const color = fluid === 'paint' ? paintColor(edge.from) : new THREE.Color(FLUIDS[fluid].color);
    paths.push({ edge, fluid, color, points: clean, ...measure(clean) });
  }

  // Segments: shared stretches of the same fluid and color merge into one pipe.
  const segments = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; fluid: Fluid; color: THREE.Color }>();
  const joints = new Map<string, { at: THREE.Vector3; fluid: Fluid; color: THREE.Color }>();
  const key = (v: THREE.Vector3): string => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
  for (const path of paths) {
    for (let index = 1; index < path.points.length; index += 1) {
      const a = path.points[index - 1] as THREE.Vector3;
      const b = path.points[index] as THREE.Vector3;
      const tag = `${path.fluid}|${path.color.getHexString()}`;
      const forward = `${tag}|${key(a)}>${key(b)}`;
      const backward = `${tag}|${key(b)}>${key(a)}`;
      if (!segments.has(forward) && !segments.has(backward)) segments.set(forward, { a, b, fluid: path.fluid, color: path.color });
      if (index < path.points.length - 1) joints.set(`${tag}|${key(b)}`, { at: b, fluid: path.fluid, color: path.color });
    }
  }

  // Overlapping straight stretches of one fluid still double up; that is fine for opaque pipes (same
  // pixels), and glass draws without depth writes.
  const solid = [...segments.values()].filter((segment) => segment.fluid !== 'tube' && segment.fluid !== 'stream');
  const glass = [...segments.values()].filter((segment) => segment.fluid === 'tube' || segment.fluid === 'stream');
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const size = new THREE.Vector3();
  const place = (mesh: THREE.InstancedMesh, slot: number, a: THREE.Vector3, b: THREE.Vector3, r: number, color: THREE.Color): void => {
    dir.subVectors(b, a);
    const length = dir.length();
    quat.setFromUnitVectors(up, dir.normalize());
    mesh.setMatrixAt(slot, matrix.compose(mid.addVectors(a, b).multiplyScalar(0.5), quat, size.set(r, length + r * 0.6, r)));
    mesh.setColorAt(slot, color);
  };

  const solidMesh = new THREE.InstancedMesh(cylinder, flowMaterial(time, { roughness: 0.35, metalness: 0.55 }, 0.9), Math.max(1, solid.length));
  solid.forEach((segment, slot) => place(solidMesh, slot, segment.a, segment.b, FLUIDS[segment.fluid].r, segment.color));
  solidMesh.count = solid.length;
  solidMesh.castShadow = true;
  group.add(solidMesh);

  // Glass: the sleeve, and inside the stream a bright core that flows.
  const sleeve = new THREE.InstancedMesh(cylinder, new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.1, depthWrite: false }), Math.max(1, glass.length));
  glass.forEach((segment, slot) => place(sleeve, slot, segment.a, segment.b, FLUIDS[segment.fluid].r, new THREE.Color('#e6f4ff')));
  sleeve.count = glass.length;
  sleeve.renderOrder = 3;
  group.add(sleeve);
  const streams = glass.filter((segment) => segment.fluid === 'stream');
  const core = new THREE.InstancedMesh(cylinder, flowMaterial(time, { emissive: '#ffb000', emissiveIntensity: 0.6, roughness: 0.4 }, 1.6), Math.max(1, streams.length));
  streams.forEach((segment, slot) => place(core, slot, segment.a, segment.b, FLUIDS.stream.r * 0.45, segment.color));
  core.count = streams.length;
  group.add(core);

  // Elbows at the corners, and rings that clamp the pipes to their supports.
  const jointList = [...joints.values()].filter((joint) => joint.fluid !== 'tube' && joint.fluid !== 'stream');
  const elbow = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.55 }), Math.max(1, jointList.length));
  jointList.forEach((joint, slot) => {
    const r = FLUIDS[joint.fluid].r * 1.15;
    elbow.setMatrixAt(slot, matrix.compose(joint.at, quat.identity(), size.set(r, r, r)));
    elbow.setColorAt(slot, joint.color.clone().multiplyScalar(0.8));
  });
  elbow.count = jointList.length;
  group.add(elbow);

  // Supports: a post beside each long horizontal stretch every few metres, with an arm under the pipe.
  const supports: THREE.Matrix4[] = [];
  for (const segment of segments.values()) {
    if (Math.abs(segment.a.y - segment.b.y) > 0.01) continue;
    const length = segment.a.distanceTo(segment.b);
    if (length < 4) continue;
    dir.subVectors(segment.b, segment.a).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(0.42);
    for (let d = 2; d < length - 1; d += 7) {
      const at = segment.a.clone().addScaledVector(dir, d);
      const foot = at.clone().add(side);
      supports.push(new THREE.Matrix4().compose(new THREE.Vector3(foot.x, at.y / 2, foot.z), quat.identity(), new THREE.Vector3(0.09, at.y, 0.09)));
      supports.push(new THREE.Matrix4().compose(new THREE.Vector3((at.x + foot.x) / 2, at.y - FLUIDS[segment.fluid].r - 0.04, (at.z + foot.z) / 2), quat.identity(), new THREE.Vector3(Math.abs(side.x) + 0.09, 0.07, Math.abs(side.z) + 0.09)));
    }
  }
  const supportMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#59616b', roughness: 0.6, metalness: 0.5 }), Math.max(1, supports.length));
  supports.forEach((m4, slot) => supportMesh.setMatrixAt(slot, m4));
  supportMesh.count = supports.length;
  supportMesh.castShadow = true;
  group.add(supportMesh);

  // Capsules in the pneumatic tubes.
  const capsules: Capsule[] = [];
  const MAX_CAPSULES = 64;
  const capsuleMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.16, 0.34, 4, 10), new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.4, emissive: '#222222' }), MAX_CAPSULES);
  for (let slot = 0; slot < MAX_CAPSULES; slot += 1) capsuleMesh.setColorAt(slot, new THREE.Color('#ffffff'));
  capsuleMesh.count = 0;
  capsuleMesh.frustumCulled = false;
  capsuleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(capsuleMesh);
  const tubeTo = new Map<string, PipePath>();
  for (const path of paths) if (path.fluid === 'tube') tubeTo.set(path.edge.to, path);

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  return {
    group,
    paths,
    callerOf(routeId) {
      return tubeTo.get(routeId)?.edge.from;
    },
    routeBetween(a, b) {
      for (const path of paths) {
        const [from, to] = path.fluid === 'stream' ? [path.edge.to, path.edge.from] : [path.edge.from, path.edge.to];
        if (from === a && to === b) return path.points.map((point) => point.clone());
        if (from === b && to === a) return path.points.map((point) => point.clone()).reverse();
      }
      return undefined;
    },
    sendCapsule(routeId, color) {
      const path = tubeTo.get(routeId);
      if (!path || capsules.length >= MAX_CAPSULES) return undefined;
      return new Promise<void>((resolve) => capsules.push({ path, distance: 0, color: new THREE.Color(color), done: resolve }));
    },
    update(dt) {
      for (let index = capsules.length - 1; index >= 0; index -= 1) {
        const capsule = capsules[index] as Capsule;
        capsule.distance += dt * 26;
        if (capsule.distance >= capsule.path.total) {
          capsules.splice(index, 1);
          capsule.done();
        }
      }
      capsules.forEach((capsule, slot) => {
        sample(capsule.path, capsule.distance, pos);
        sample(capsule.path, Math.min(capsule.path.total, capsule.distance + 0.3), ahead);
        dir.subVectors(ahead, pos);
        if (dir.lengthSq() > 1e-6) quat.setFromUnitVectors(up, dir.normalize());
        capsuleMesh.setMatrixAt(slot, matrix.compose(pos, quat, size.set(1, 1, 1)));
        capsuleMesh.setColorAt(slot, capsule.color);
      });
      capsuleMesh.count = capsules.length;
      capsuleMesh.instanceMatrix.needsUpdate = true;
      if (capsuleMesh.instanceColor) capsuleMesh.instanceColor.needsUpdate = true;
    },
  };
}


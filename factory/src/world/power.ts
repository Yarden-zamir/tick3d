// Power: what runs the code, and line shafts that carry it to every zone (one under each roof, the way
// old factories drove their machines).
// - Windmills are the browser. Client code runs on the players' devices: power from outside that
//   varies with how many players there are.
// - The water wheel is the Node server: one steady process, driven by the requests that flow in down
//   the canal. Its shaft drives the API Plant, the Vault, and the Rules Foundry (the server runs the
//   rules too).
// - The AI Lab has its own small windmill, not joined to anything: the Web Worker is its own thread.
// - Steam engines are the GitHub Actions runners, one per runner type a zone's jobs use. They stand
//   cold until a job runs. The CI yard's shaft runs on to the container port: the deploy job builds the
//   Docker image.

import * as THREE from 'three';
import type { FactoryModel, ZoneId } from '../../scan/model.ts';
import type { Layout, Plot } from '../layout.ts';
import { CELL } from '../layout.ts';
import { C, CYL, CYL8, Merger, RING } from './kit.ts';
import type { Landscape } from './landscape.ts';
import type { Post } from './machines.ts';

export type Source = 'wind' | 'water' | 'worker' | 'steam';

export const SOURCES: Record<Source, { name: string; meaning: string; color: string }> = {
  wind: { name: 'Windmill · the browser', meaning: 'This zone’s code runs in the players’ browsers. The sails turn faster when more players are on.', color: '#f4f1ea' },
  water: { name: 'Water wheel · the Node server', meaning: 'This zone’s code runs in the Node server, one steady process. Requests flowing in down the canal from the Caddy gate turn the wheel.', color: '#4d7cfe' },
  worker: { name: 'Own windmill · the Web Worker', meaning: 'The computer opponent searches moves on its own thread, so the AI Lab has its own windmill, not joined to any other shaft.', color: '#c084fc' },
  steam: { name: 'Steam engines · GitHub Actions runners', meaning: 'This zone’s jobs run on GitHub-hosted runners. Each engine is a runner type; it fires up while one of its jobs runs.', color: '#e95420' },
};

const ZONE_POWER: Partial<Record<ZoneId, Source[]>> = {
  storefront: ['wind'],
  assembly: ['wind'],
  acoustics: ['wind'],
  nearby: ['wind'],
  device: ['wind'],
  foundry: ['wind', 'water'],
  api: ['water'],
  vault: ['water'],
  ai: ['worker'],
};

export interface Power {
  group: THREE.Group;
  sources: Map<ZoneId, { source: Source; detail: string }[]>;
  posts: Post[];
  update(dt: number, levels: { players: number; water: number; busy: (zone: ZoneId) => boolean }): void;
}

interface Shaft {
  a: THREE.Vector3;
  b: THREE.Vector3;
  network: string;
}

const RUNNER_COLORS: Record<string, string> = { ubuntu: '#e95420', macos: '#d4d8de', reusable: '#8a63d2' };

function runnerOf(data: Record<string, unknown> | undefined): string {
  const runsOn = String(data?.runsOn ?? '');
  if (runsOn.includes('macos')) return 'macos';
  if (runsOn.includes('ubuntu')) return 'ubuntu';
  return 'reusable';
}

export function buildPower(model: FactoryModel, layout: Layout, ceilings: Map<ZoneId, number>, landscape: Landscape): Power {
  const group = new THREE.Group();
  const m = new Merger();
  const posts: Post[] = [];
  const shafts: Shaft[] = [];
  const sources = new Map<ZoneId, { source: Source; detail: string }[]>();
  const add = (zone: ZoneId, source: Source, detail: string): void => {
    sources.set(zone, [...(sources.get(zone) ?? []), { source, detail }]);
  };
  const plotOf = (zone: ZoneId): Plot | undefined => layout.plots.get(zone);
  const line = (plot: Plot): { y: number; z: number } => ({ y: (ceilings.get(plot.zone) ?? 6.5) - 0.6, z: plot.minZ + 1.5 + (plot.rows * CELL + 3) / 2 });
  const gearbox = (at: THREE.Vector3): void => m.block(C('#3b4148'), at.x, at.y - 0.3, at.z, 0.6, 0.6, 0.6);
  const run = (network: string, points: THREE.Vector3[]): void => {
    for (let index = 1; index < points.length; index += 1) {
      shafts.push({ a: points[index - 1] as THREE.Vector3, b: points[index] as THREE.Vector3, network });
      if (index < points.length - 1) gearbox(points[index] as THREE.Vector3);
    }
  };
  // The line shaft under a zone's roof, west to east.
  const lineShaft = (plot: Plot, network: string): void => {
    const { y, z } = line(plot);
    run(network, [new THREE.Vector3(plot.minX + 0.8, y, z), new THREE.Vector3(plot.maxX - 0.8, y, z)]);
  };

  // Windmills.
  const sails: { group: THREE.Group; network: string }[] = [];
  const windmill = (plot: Plot, network: string, small: boolean, sailColor: string): void => {
    const x = plot.minX - 3.5;
    const z = plot.minZ + 2.5;
    const height = small ? 10 : 15;
    m.add(CYL8, C('#e8e2d4'), x, height / 2, z, 2.6, height, 2.6);
    m.add(CYL8, C('#7a4b2a'), x, height + 0.6, z, 3, 1.2, 3);
    posts.push({ x, z, r: 1.4, h: height });
    const hub = new THREE.Group();
    hub.position.set(x, height + 0.4, z + 1.7);
    const blades = new Merger();
    const length = small ? 3.6 : 5.2;
    for (let index = 0; index < 4; index += 1) {
      const angle = (index / 4) * Math.PI * 2;
      blades.add(new THREE.BoxGeometry(1, 1, 1), C('#6b4a2f'), Math.cos(angle) * length * 0.5, Math.sin(angle) * length * 0.5, 0, length, 0.18, 0.12, 0, 0, angle);
      blades.add(new THREE.BoxGeometry(1, 1, 1), C(sailColor), Math.cos(angle) * length * 0.58 + Math.cos(angle + Math.PI / 2) * 0.55, Math.sin(angle) * length * 0.58 + Math.sin(angle + Math.PI / 2) * 0.55, 0.05, length * 0.8, 1.0, 0.04, 0, 0, angle);
    }
    blades.add(CYL, C('#3b3533'), 0, 0, -0.2, 0.6, 0.8, 0.6, Math.PI / 2, 0, 0);
    const mesh = blades.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
    if (mesh) {
      mesh.castShadow = true;
      hub.add(mesh);
    }
    group.add(hub);
    sails.push({ group: hub, network });
    // Down the tower and along the outside of the plot to the line shaft.
    const { y, z: lz } = line(plot);
    run(network, [new THREE.Vector3(x + 1.5, y, z), new THREE.Vector3(x + 1.5, y, lz), new THREE.Vector3(plot.minX + 0.8, y, lz)]);
    lineShaft(plot, network);
  };

  for (const [zone, list] of Object.entries(ZONE_POWER) as [ZoneId, Source[]][]) {
    const plot = plotOf(zone);
    if (!plot) continue;
    if (list.includes('wind')) {
      windmill(plot, `wind:${zone}`, false, '#f4f1ea');
      add(zone, 'wind', 'Its own windmill at the north-west corner.');
    }
    if (list.includes('worker')) {
      windmill(plot, 'worker', true, '#c084fc');
      add(zone, 'worker', 'A small windmill of its own, joined to nothing else.');
    }
  }

  // The water wheel's shaft: up from the axle, north under the API Plant's roof, then on to the Vault
  // (east) and the Rules Foundry (west).
  const api = plotOf('api');
  if (api) {
    const { y, z } = line(api);
    const axle = new THREE.Vector3(landscape.wheel.x + 1.6, landscape.wheel.y, landscape.wheel.z);
    run('water', [axle, new THREE.Vector3(axle.x, y, axle.z), new THREE.Vector3(axle.x, y, z)]);
    lineShaft(api, 'water');
    add('api', 'water', 'The water wheel on the canal, just south of the hall.');
    for (const [zone, side] of [['vault', 1], ['foundry', -1]] as const) {
      const other = plotOf(zone);
      if (!other) continue;
      const target = line(other);
      const gap = side > 0 ? (api.maxX + other.minX) / 2 + 3 : (other.maxX + api.minX) / 2 - 3;
      const from = side > 0 ? api.maxX - 0.8 : api.minX + 0.8;
      const to = side > 0 ? other.minX + 0.8 : other.maxX - 0.8;
      run('water', [new THREE.Vector3(from, y, z), new THREE.Vector3(gap, y, z), new THREE.Vector3(gap, target.y, z), new THREE.Vector3(gap, target.y, target.z), new THREE.Vector3(to, target.y, target.z)]);
      if (zone === 'vault') lineShaft(other, 'water');
      else run('water', [new THREE.Vector3(other.maxX - 0.8, target.y, target.z + 0.01), new THREE.Vector3(other.minX + 0.8, target.y, target.z + 0.01)]);
      add(zone, 'water', zone === 'vault' ? 'A shaft from the API Plant’s water wheel: the store writes DuckDB inside the server.' : 'A shaft from the API Plant’s water wheel as well: the server runs these rules for online games.');
    }
  }

  // Steam engines, one per runner type of each zone's jobs.
  const engines: { flywheel: THREE.Group; chimney: THREE.Vector3; zone: ZoneId; puff: number }[] = [];
  const runners = new Map<ZoneId, Map<string, number>>();
  for (const entity of model.entities) {
    if (entity.kind !== 'job') continue;
    const byRunner = runners.get(entity.zone) ?? new Map<string, number>();
    const runner = runnerOf(entity.data);
    byRunner.set(runner, (byRunner.get(runner) ?? 0) + 1);
    runners.set(entity.zone, byRunner);
  }
  for (const [zone, byRunner] of runners) {
    const plot = plotOf(zone);
    if (!plot) continue;
    const network = `steam:${zone}`;
    const { y, z: lz } = line(plot);
    [...byRunner.entries()].forEach(([runner, jobs], index) => {
      const x = plot.maxX + 4;
      const z = plot.minZ + 3 + index * 5.5;
      const color = C(RUNNER_COLORS[runner] ?? '#888888');
      // Boiler, firebox, chimney and flywheel.
      m.add(CYL, color, x + 0.6, 1.4, z, 2, 3.6, 2, Math.PI / 2, 0, 0);
      m.block(C('#2a2f35'), x + 0.6, 0, z + 1.8, 2.2, 1.6, 0.8);
      m.add(CYL8, C('#2a2f35'), x + 0.6, 4.6, z - 1.2, 0.7, 4, 0.7);
      posts.push({ x: x + 0.6, z, r: 1.3, h: 2.4 });
      const flywheel = new THREE.Group();
      flywheel.position.set(x - 0.9, 1.6, z);
      const wheel = new Merger();
      wheel.add(RING, C('#3b4148'), 0, 0, 0, 2.6, 2.6, 2.6, 0, Math.PI / 2, 0);
      for (let spoke = 0; spoke < 3; spoke += 1) wheel.add(new THREE.BoxGeometry(1, 1, 1), C('#5d6670'), 0, 0, 0, 0.1, 2.5, 0.12, (spoke / 3) * Math.PI, 0, 0);
      const mesh = wheel.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.7 }));
      if (mesh) flywheel.add(mesh);
      group.add(flywheel);
      engines.push({ flywheel, chimney: new THREE.Vector3(x + 0.6, 6.8, z - 1.2), zone, puff: 0 });
      run(network, [new THREE.Vector3(x - 1, 1.6, z), new THREE.Vector3(plot.maxX + 1.5, 1.6, z), new THREE.Vector3(plot.maxX + 1.5, y, z), new THREE.Vector3(plot.maxX + 1.5, y, lz), new THREE.Vector3(plot.maxX - 0.8, y, lz)]);
      add(zone, 'steam', `A ${runner === 'reusable' ? 'reusable-workflow' : runner} engine (${jobs} job${jobs === 1 ? '' : 's'}).`);
    });
    lineShaft(plot, network);
  }
  // The CI yard's shaft runs on to the container port.
  const ci = plotOf('ci');
  const port = plotOf('packaging');
  if (ci && port && runners.has('ci')) {
    const a = line(ci);
    const b = line(port);
    const gap = (ci.maxX + port.minX) / 2 + 3;
    run('steam:ci', [new THREE.Vector3(ci.maxX - 0.8, a.y, a.z), new THREE.Vector3(gap, a.y, a.z), new THREE.Vector3(gap, b.y, a.z), new THREE.Vector3(gap, b.y, b.z), new THREE.Vector3(port.minX + 0.8, b.y, b.z)]);
    lineShaft(port, 'steam:ci');
    add('packaging', 'steam', 'A shaft from the CI yard’s steam engines: the deploy job builds the Docker image on a runner.');
  }

  const staticMesh = m.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }));
  if (staticMesh) {
    staticMesh.castShadow = true;
    group.add(staticMesh);
  }

  // Shafts: a rod with a flat key along it, so you can see it turn.
  const shaftGeometry = (() => {
    const rod = new THREE.CylinderGeometry(0.1, 0.1, 1, 8).toNonIndexed();
    const key = new THREE.BoxGeometry(0.06, 1, 0.24).toNonIndexed();
    key.translate(0, 0, 0.06);
    rod.deleteAttribute('uv');
    key.deleteAttribute('uv');
    const merged = new THREE.BufferGeometry();
    const positions = [...rod.getAttribute('position').array, ...key.getAttribute('position').array];
    const normals = [...rod.getAttribute('normal').array, ...key.getAttribute('normal').array];
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return merged;
  })();
  const shaftMesh = new THREE.InstancedMesh(shaftGeometry, new THREE.MeshStandardMaterial({ color: '#b8bec6', metalness: 0.8, roughness: 0.3 }), Math.max(1, shafts.length));
  shaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shaftMesh.frustumCulled = false;
  group.add(shaftMesh);
  const angles = new Map<string, number>();
  const speeds = new Map<string, number>();

  // Steam puffs.
  const PUFFS = 48;
  const puffs: { at: THREE.Vector3; age: number }[] = [];
  const puffMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.6, 1), new THREE.MeshLambertMaterial({ color: '#f4f6f8', flatShading: true }), PUFFS);
  puffMesh.count = 0;
  puffMesh.frustumCulled = false;
  puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(puffMesh);

  const matrix = new THREE.Matrix4();
  const align = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const size = new THREE.Vector3();

  return {
    group,
    sources,
    posts,
    update(dt, levels) {
      // Network speeds, in turns per second (shafts) and radians per second (sails).
      for (const network of new Set(shafts.map((shaft) => shaft.network).concat(sails.map((sail) => sail.network)))) {
        let goal = 0;
        if (network.startsWith('wind:')) goal = 0.4 + levels.players * 1.6;
        else if (network === 'worker') goal = 1.2;
        else if (network === 'water') goal = 0.3 + levels.water * 2.2;
        else if (network.startsWith('steam:')) goal = levels.busy(network.slice(6) as ZoneId) ? 3 : 0;
        const speed = (speeds.get(network) ?? goal) + (goal - (speeds.get(network) ?? goal)) * Math.min(1, dt * 1.5);
        speeds.set(network, speed);
        angles.set(network, ((angles.get(network) ?? 0) + speed * dt * 2) % (Math.PI * 2));
      }
      for (const sail of sails) sail.group.rotation.z -= (speeds.get(sail.network) ?? 0) * dt;
      shafts.forEach((shaft, slot) => {
        dir.subVectors(shaft.b, shaft.a);
        const length = dir.length();
        align.setFromUnitVectors(up, dir.normalize());
        spin.setFromAxisAngle(up, angles.get(shaft.network) ?? 0);
        quat.multiplyQuaternions(align, spin);
        shaftMesh.setMatrixAt(slot, matrix.compose(mid.addVectors(shaft.a, shaft.b).multiplyScalar(0.5), quat, size.set(1, length, 1)));
      });
      shaftMesh.instanceMatrix.needsUpdate = true;

      for (const engine of engines) {
        const speed = speeds.get(`steam:${engine.zone}`) ?? 0;
        engine.flywheel.rotation.x -= speed * dt * 2;
        if (speed > 0.5) {
          engine.puff -= dt;
          if (engine.puff <= 0 && puffs.length < PUFFS) {
            engine.puff = 0.35;
            puffs.push({ at: engine.chimney.clone(), age: 0 });
          }
        }
      }
      for (let index = puffs.length - 1; index >= 0; index -= 1) {
        const puff = puffs[index] as { at: THREE.Vector3; age: number };
        puff.age += dt;
        puff.at.y += dt * 1.8;
        puff.at.x += dt * 0.6;
        if (puff.age > 2.4) puffs.splice(index, 1);
      }
      puffs.forEach((puff, slot) => {
        const grow = 0.6 + puff.age * 0.9;
        const fade = puff.age > 1.8 ? Math.max(0.05, 1 - (puff.age - 1.8) / 0.6) : 1;
        puffMesh.setMatrixAt(slot, matrix.compose(puff.at, quat.identity(), size.setScalar(grow * fade)));
      });
      puffMesh.count = puffs.length;
      puffMesh.instanceMatrix.needsUpdate = true;
    },
  };
}


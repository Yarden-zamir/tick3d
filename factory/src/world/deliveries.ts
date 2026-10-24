// Deliveries: how things enter and leave the factory, each in its own way.
// - Trucks bring npm packages from the registry gate in the west to the Raw Materials Dock.
// - The train takes the Docker images (build, api, site) from the container port east to the server:
//   a deploy to prod, or a preview for a pull request.
// - Ships take the apps across the internet to the stores: Google Play and TestFlight.
// - A cable car carries messages between the page (computer.ts) and the Web Worker on its own thread.
// - Radio pulses fly between the Nearby masts: WebRTC, device to device.
// - Pigeons circle the files that use a BroadcastChannel: messages to other tabs of the same browser.

import * as THREE from 'three';
import type { Entity, FactoryModel } from '../../scan/model.ts';
import type { Layout } from '../layout.ts';
import { C, CYL, CYL8, GABLE, Merger, SPHERE } from './kit.ts';
import type { Landscape } from './landscape.ts';
import { type P2, offsetPath } from './routes.ts';

export interface Deliveries {
  group: THREE.Group;
  /** Send a truck with one npm package; answers the package, or undefined while the road is busy. */
  truck(): Entity | undefined;
  train(kind: 'prod' | 'preview'): boolean;
  ship(zone: 'android' | 'ios'): boolean;
  message(): void;
  radio(burst: number): void;
  update(dt: number, players: number): void;
}

const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 });

function model(build: (m: Merger) => void): THREE.Mesh {
  const m = new Merger();
  build(m);
  const mesh = m.build(solidMaterial);
  if (!mesh) throw new Error('empty model');
  mesh.castShadow = true;
  return mesh;
}

interface Mover {
  mesh: THREE.Object3D;
  points: THREE.Vector3[];
  lengths: number[];
  total: number;
  distance: number;
  speed: number;
}

function mover(mesh: THREE.Object3D, points: THREE.Vector3[], speed: number): Mover {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) lengths.push((lengths[index - 1] ?? 0) + (points[index - 1] as THREE.Vector3).distanceTo(points[index] as THREE.Vector3));
  return { mesh, points, lengths, total: lengths[lengths.length - 1] ?? 0, distance: 0, speed };
}

/** Moves along the path and faces the way it goes; answers true at the end. */
function advance(item: Mover, dt: number): boolean {
  item.distance = Math.min(item.total, item.distance + dt * item.speed);
  let index = 1;
  while (index < item.lengths.length - 1 && (item.lengths[index] ?? 0) < item.distance) index += 1;
  const a = item.points[index - 1] as THREE.Vector3;
  const b = item.points[index] as THREE.Vector3;
  const start = item.lengths[index - 1] ?? 0;
  const span = (item.lengths[index] ?? 0) - start;
  item.mesh.position.copy(a).lerp(b, span > 0 ? (item.distance - start) / span : 0);
  if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-3) item.mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  return item.distance >= item.total;
}

export function buildDeliveries(factory: FactoryModel, layout: Layout, landscape: Landscape): Deliveries {
  const group = new THREE.Group();
  const deps = factory.entities.filter((entity) => entity.kind === 'dep');

  // Trucks: along the highway's eastbound lane, up to the dock, then back on the other lane.
  const { highway } = landscape;
  const road: P2[] = [
    { x: highway.west, z: highway.z },
    { x: highway.dock.x, z: highway.z },
    { x: highway.dock.x, z: highway.dock.z + 2 },
  ];
  const inbound = offsetPath(road, 0.9).map((point) => new THREE.Vector3(point.x, -0.15, point.z));
  const outbound = offsetPath([...road].reverse(), 0.9).map((point) => new THREE.Vector3(point.x, -0.15, point.z));
  const trucks: { mover: Mover; cargo: THREE.Mesh; phase: 'in' | 'unload' | 'out'; wait: number }[] = [];
  const truckBody = (): THREE.Mesh =>
    model((m) => {
      m.block(C('#cb3837'), 1.9, 0.5, 0, 1.6, 1.5, 1.9);
      m.block(C('#9fd3f5'), 2.55, 1.25, 0, 0.3, 0.6, 1.6);
      m.block(C('#3b3f45'), -0.6, 0.5, 0, 3.6, 0.25, 2);
      for (const x of [-1.6, 0.4, 2.1]) for (const z of [-0.9, 0.9]) m.add(CYL8, C('#1d2024'), x, 0.42, z, 0.8, 0.3, 0.8, Math.PI / 2, 0, 0);
    });

  // The train: a locomotive and three flatcars, one container per Docker stage.
  const train = new THREE.Group();
  const loco = model((m) => {
    m.block(C('#2a2f35'), 0, 0.1, 0, 5, 0.5, 2);
    m.add(CYL, C('#2496ed'), 0.6, 1.6, 0, 1.7, 3.6, 1.7, 0, 0, Math.PI / 2);
    m.block(C('#1b6fb3'), -1.6, 0.6, 0, 1.8, 2.4, 2);
    m.add(CYL8, C('#2a2f35'), 1.8, 3, 0, 0.5, 1.2, 0.5);
    for (const x of [-1.8, -0.4, 1, 2]) for (const z of [-0.85, 0.85]) m.add(CYL8, C('#1d2024'), x, 0.45, z, 0.9, 0.25, 0.9, Math.PI / 2, 0, 0);
  });
  // The flag says where the train goes: green for prod, purple for a preview.
  const flagMaterial = new THREE.MeshStandardMaterial({ color: '#3ddc84', side: THREE.DoubleSide });
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 1), flagMaterial);
  flag.position.set(-1.6, 3.4, 0.4);
  loco.add(flag);
  train.add(loco);
  const STAGES = ['#f2a03d', '#4d7cfe', '#3ddc84'];
  const containers: THREE.Mesh[] = [];
  STAGES.forEach((color, index) => {
    const car = model((m) => {
      m.block(C('#4b4f55'), 0, 0.1, 0, 5.6, 0.4, 2);
      for (const x of [-2, 2]) for (const z of [-0.85, 0.85]) m.add(CYL8, C('#1d2024'), x, 0.45, z, 0.9, 0.25, 0.9, Math.PI / 2, 0, 0);
    });
    car.position.x = -6.2 * (index + 1);
    const box = model((m) => m.block(C(color), 0, 0, 0, 5.2, 2.3, 2.2));
    box.position.y = 0.5;
    car.add(box);
    containers.push(box);
    train.add(car);
  });
  const station = landscape.rail.station + 6;
  train.position.set(station, -0.05, landscape.rail.z);
  group.add(train);
  let trainState: { phase: 'idle' | 'out' | 'back'; x: number } = { phase: 'idle', x: station };

  // Ships, moored at their berths until a release sails.
  const ships = new Map<'android' | 'ios', { mesh: THREE.Group; berth: THREE.Vector3; sail?: Mover; phase: 'moored' | 'out' | 'back'; wait: number }>();
  for (const zone of ['android', 'ios'] as const) {
    const berth = landscape.berths.get(zone);
    if (!berth) continue;
    const color = zone === 'android' ? '#3ddc84' : '#c7ccd3';
    const ship = new THREE.Group();
    ship.add(
      model((m) => {
        m.block(C('#2d3a4a'), 0, -0.6, 0, 9, 1.6, 3.2);
        m.add(GABLE, C('#2d3a4a'), 4.5, -0.6, 0, 3.2, 1.6, 1.6, 0, Math.PI / 2, -Math.PI / 2);
        m.block(C('#f4f4f4'), -2.6, 1, 0, 2.6, 2, 2.6);
        m.block(C('#9fd3f5'), -2.6, 2.3, 0, 2.7, 0.5, 2.7);
        m.block(C(color), 1, 1, 0, 3.4, 1.6, 2.2);
        m.block(C('#2a2f35'), -2.6, 3, 0, 0.12, 2.4, 0.12);
        m.block(C(color), -2.4, 4.6, 0.6, 0.05, 0.8, 1.2);
      }),
    );
    ship.position.copy(berth);
    group.add(ship);
    ships.set(zone, { mesh: ship, berth, phase: 'moored', wait: 0 });
  }

  // The cable car between the page and the Worker.
  const pageSide = layout.places.get('src/page/computer.ts');
  const workerSide = layout.places.get('src/ai-worker.ts');
  const cableY = 21;
  let cable: { a: THREE.Vector3; b: THREE.Vector3; cabin: THREE.Mesh; t: number; dir: number; queued: number; wait: number } | undefined;
  if (pageSide && workerSide) {
    const a = new THREE.Vector3(pageSide.x + 1.4, cableY, pageSide.z - 1.4);
    const b = new THREE.Vector3(workerSide.x + 1.4, cableY, workerSide.z - 1.4);
    group.add(
      model((m) => {
        for (const end of [a, b]) {
          m.beam(C('#c084fc'), new THREE.Vector3(end.x, 0, end.z), new THREE.Vector3(end.x, cableY + 0.6, end.z), 0.18);
          m.block(C('#7a4fb0'), end.x, cableY + 0.4, end.z, 1.2, 0.5, 1.2);
        }
        m.beam(C('#2a2f35'), a.clone().setY(cableY + 0.5), b.clone().setY(cableY + 0.5), 0.04);
      }),
    );
    const cabin = model((m) => {
      m.block(C('#c084fc'), 0, -2.2, 0, 1.4, 1.2, 1);
      m.block(C('#efe2ff'), 0, -1.6, 0, 1.5, 0.3, 1.1);
      m.block(C('#2a2f35'), 0, -1.3, 0, 0.06, 1.3, 0.06);
    });
    cabin.position.copy(a).setY(cableY + 0.5);
    group.add(cabin);
    cable = { a, b, cabin, t: 0, dir: 0, queued: 0, wait: 0 };
  }

  // Radio pulses between the Nearby masts (the dishes, as styles.ts builds them).
  const nearby = layout.plots.get('nearby');
  const dishA = nearby ? new THREE.Vector3(nearby.minX + 3.4, 16, nearby.minZ + 3.1) : undefined;
  const dishB = nearby ? new THREE.Vector3(nearby.maxX - 3.4, 16, nearby.minZ + 3.1) : undefined;
  const PULSES = 16;
  const pulses: { t: number; forward: boolean }[] = [];
  const pulseMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 12, 8), new THREE.MeshBasicMaterial({ color: '#ff6b6b', toneMapped: false }), PULSES);
  pulseMesh.count = 0;
  pulseMesh.frustumCulled = false;
  group.add(pulseMesh);
  let radioClock = 0;

  // Pigeons over each file that opens a BroadcastChannel.
  const lofts = factory.entities.filter((entity) => Array.isArray(entity.data?.channels) && (entity.data.channels as string[]).includes('broadcast'));
  const pigeons: { mesh: THREE.Mesh; center: THREE.Vector3; radius: number; speed: number; phase: number }[] = [];
  for (const entity of lofts) {
    const place = layout.places.get(entity.id);
    if (!place) continue;
    group.add(
      model((m) => {
        m.block(C('#e9e1cf'), place.x, place.h, place.z, 1.2, 0.9, 1.2);
        m.add(GABLE, C('#8a5a33'), place.x, place.h + 0.9, place.z, 1.4, 0.6, 1.4);
        m.block(C('#2a2f35'), place.x, place.h + 0.3, place.z + 0.61, 0.4, 0.4, 0.02);
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      const mesh = model((m) => {
        m.add(SPHERE, C('#c9ccd3'), 0, 0, 0, 0.7, 0.35, 0.35);
        m.add(SPHERE, C('#8d93a0'), 0.3, 0.1, 0, 0.26, 0.26, 0.26);
        m.block(C('#e9ecef'), 0, 0.02, 0, 0.3, 0.04, 1.2);
      });
      group.add(mesh);
      pigeons.push({ mesh, center: new THREE.Vector3(place.x, place.h + 3, place.z), radius: 3 + index * 1.4, speed: 0.9 + index * 0.25, phase: index * 2.1 });
    }
  }
  let clock = 0;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  return {
    group,
    truck() {
      if (trucks.length >= 2 || deps.length === 0) return undefined;
      const dep = deps[Math.floor(Math.random() * deps.length)] as Entity;
      const body = truckBody();
      const cargo = model((m) => {
        if (dep.data?.runtime === true) for (const [x, z] of [[-1.6, -0.5], [-1.6, 0.5], [-0.4, -0.5], [-0.4, 0.5], [0.8, 0]] as const) m.add(CYL8, C('#b5835a'), x, 1.15, z, 0.9, 1.2, 0.9);
        else m.block(C('#c9a46a'), -0.4, 0.75, 0, 3.2, 1.4, 1.8);
      });
      body.add(cargo);
      group.add(body);
      trucks.push({ mover: mover(body, inbound, 11), cargo, phase: 'in', wait: 0 });
      return dep;
    },
    train(kind) {
      if (trainState.phase !== 'idle') return false;
      flagMaterial.color.set(kind === 'prod' ? '#3ddc84' : '#a06cf5');
      for (const box of containers) box.visible = true;
      trainState = { phase: 'out', x: station };
      return true;
    },
    ship(zone) {
      const ship = ships.get(zone);
      if (!ship || ship.phase !== 'moored') return false;
      const { berth } = ship;
      const mid = (landscape.river.north + landscape.river.south) / 2;
      ship.sail = mover(ship.mesh, [berth.clone(), new THREE.Vector3(berth.x + 14, 0, mid), new THREE.Vector3(landscape.rail.east, 0, mid)], 9);
      ship.phase = 'out';
      return true;
    },
    message() {
      if (cable) cable.queued += 1;
    },
    radio(burst) {
      for (let index = 0; index < burst && pulses.length < PULSES; index += 1) pulses.push({ t: -index * 0.18, forward: index % 2 === 0 });
    },
    update(dt, players) {
      clock += dt;
      for (let index = trucks.length - 1; index >= 0; index -= 1) {
        const truck = trucks[index];
        if (!truck) continue;
        if (truck.phase === 'unload') {
          truck.wait -= dt;
          if (truck.wait <= 0) {
            truck.cargo.visible = false;
            truck.phase = 'out';
            truck.mover = mover(truck.mover.mesh, outbound, 11);
          }
        } else if (advance(truck.mover, dt)) {
          if (truck.phase === 'in') {
            truck.phase = 'unload';
            truck.wait = 2.5;
          } else {
            group.remove(truck.mover.mesh);
            trucks.splice(index, 1);
          }
        }
      }

      if (trainState.phase === 'out') {
        trainState.x += dt * Math.min(22, 4 + (trainState.x - station) * 0.5);
        if (trainState.x > landscape.rail.east) {
          trainState.phase = 'back';
          for (const box of containers) box.visible = false;
        }
      } else if (trainState.phase === 'back') {
        trainState.x -= dt * 26;
        if (trainState.x <= station) trainState = { phase: 'idle', x: station };
      }
      train.position.x = trainState.x;

      for (const ship of ships.values()) {
        if (ship.phase === 'moored') {
          ship.mesh.position.y = Math.sin(clock * 1.3 + ship.berth.x) * 0.08;
          continue;
        }
        if (!ship.sail) continue;
        if (advance(ship.sail, dt)) {
          if (ship.phase === 'out') {
            ship.phase = 'back';
            ship.sail = mover(ship.mesh, [...ship.sail.points].reverse(), 14);
          } else {
            ship.phase = 'moored';
            ship.mesh.rotation.y = 0;
          }
        }
      }

      if (cable) {
        // Players on a computer game send a move request now and then.
        if (Math.random() < dt * players * 0.08) cable.queued = Math.max(cable.queued, 1);
        if (cable.dir === 0 && cable.queued > 0) {
          cable.queued -= 1;
          cable.dir = 1;
        }
        if (cable.dir !== 0) {
          if (cable.wait > 0) cable.wait -= dt;
          else {
            cable.t = THREE.MathUtils.clamp(cable.t + cable.dir * dt * 0.35, 0, 1);
            if (cable.t >= 1 && cable.dir === 1) {
              cable.dir = -1;
              cable.wait = 1.2;
            } else if (cable.t <= 0 && cable.dir === -1) cable.dir = 0;
          }
        }
        cable.cabin.position.lerpVectors(cable.a, cable.b, cable.t).setY(cableY + 0.5 - Math.sin(cable.t * Math.PI) * 1.2);
      }

      if (dishA && dishB) {
        radioClock -= dt;
        if (radioClock <= 0 && players > 0.2) {
          radioClock = 1.6 / players;
          if (pulses.length < PULSES) pulses.push({ t: 0, forward: Math.random() < 0.5 });
        }
        for (let index = pulses.length - 1; index >= 0; index -= 1) {
          const pulse = pulses[index] as { t: number; forward: boolean };
          pulse.t += dt * 0.9;
          if (pulse.t > 1) pulses.splice(index, 1);
        }
        let slot = 0;
        for (const pulse of pulses) {
          if (pulse.t < 0) continue;
          pos.lerpVectors(pulse.forward ? dishA : dishB, pulse.forward ? dishB : dishA, pulse.t);
          pos.y += Math.sin(pulse.t * Math.PI) * 2;
          pulseMesh.setMatrixAt(slot, matrix.compose(pos, quat, one));
          slot += 1;
        }
        pulseMesh.count = slot;
        pulseMesh.instanceMatrix.needsUpdate = true;
      }

      for (const pigeon of pigeons) {
        const angle = clock * pigeon.speed + pigeon.phase;
        pigeon.mesh.position.set(pigeon.center.x + Math.cos(angle) * pigeon.radius, pigeon.center.y + Math.sin(clock * 2 + pigeon.phase) * 0.6, pigeon.center.z + Math.sin(angle) * pigeon.radius);
        pigeon.mesh.rotation.y = -angle - Math.PI / 2;
        pigeon.mesh.scale.z = 0.6 + Math.abs(Math.sin(clock * 14 + pigeon.phase)) * 0.6;
      }
    },
  };
}

// Scene-view overlays in the Unity manner (an orange selection box with a move gizmo, a hover box, a
// zone outline) and the animated effects: packets that travel a real belt route or arc through the
// air, and rings that ping where a packet lands.

import * as THREE from 'three';

interface Packet {
  points: THREE.Vector3[];
  lengths: number[];
  total: number;
  travelled: number;
  speed: number;
  head: THREE.Mesh;
  trail: THREE.Line;
  trailPoints: THREE.Vector3[];
  color: THREE.Color;
  done: () => void;
}

interface Ping {
  mesh: THREE.Mesh;
  age: number;
  life: number;
}

export interface Effects {
  select(box: THREE.Box3 | null): void;
  hover(box: THREE.Box3 | null): void;
  outlineZone(rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null, color?: string): void;
  /** Sends a glowing packet along the points; resolves when it lands. */
  packet(points: THREE.Vector3[], color: string, seconds: number): Promise<void>;
  /** An arc through the air from a to b. */
  arc(a: THREE.Vector3, b: THREE.Vector3, lift?: number): THREE.Vector3[];
  ping(at: THREE.Vector3, color: string, size?: number): void;
  update(dt: number, camera: THREE.Camera): void;
  clearPackets(): void;
  setGizmos(on: boolean): void;
}

const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

function overlay(color: string, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
}

export function createEffects(scene: THREE.Scene): Effects {
  const selected = new THREE.LineSegments(boxEdges, overlay('#ff9a1f', 0.95));
  selected.renderOrder = 10;
  selected.visible = false;
  const hovered = new THREE.LineSegments(boxEdges, overlay('#d7e6ff', 0.55));
  hovered.renderOrder = 9;
  hovered.visible = false;

  // The move gizmo: red X, green Y, blue Z, and the small grey center square of Unity.
  const gizmo = new THREE.Group();
  const arrow = (dir: THREE.Vector3, color: string): THREE.Group => {
    const part = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.6, 8), material);
    shaft.position.y = 0.8;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 14), material);
    tip.position.y = 1.75;
    part.add(shaft, tip);
    part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    part.traverse((child) => {
      child.renderOrder = 12;
    });
    return part;
  };
  gizmo.add(arrow(new THREE.Vector3(1, 0, 0), '#e8403a'), arrow(new THREE.Vector3(0, 1, 0), '#7ed321'), arrow(new THREE.Vector3(0, 0, 1), '#3a7bff'));
  const center = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: '#dddddd', depthTest: false, toneMapped: false }));
  center.renderOrder = 12;
  gizmo.add(center);
  gizmo.visible = false;
  let gizmos = true;

  const zoneLine = new THREE.LineLoop(new THREE.BufferGeometry(), overlay('#ffffff', 0.9));
  zoneLine.renderOrder = 8;
  zoneLine.visible = false;

  scene.add(selected, hovered, gizmo, zoneLine);

  const packets: Packet[] = [];
  const pings: Ping[] = [];
  const headGeometry = new THREE.SphereGeometry(0.32, 16, 12);
  const ringGeometry = new THREE.RingGeometry(0.8, 1, 48);
  ringGeometry.rotateX(-Math.PI / 2);
  const tmp = new THREE.Vector3();
  let zonePulse = 0;

  const placeBox = (object: THREE.Object3D, box: THREE.Box3, pad: number): void => {
    const size = box.getSize(tmp);
    object.scale.set(size.x + pad, size.y + pad, size.z + pad);
    box.getCenter(object.position);
  };

  let selectedBox: THREE.Box3 | null = null;

  return {
    select(box) {
      selectedBox = box;
      selected.visible = box !== null;
      gizmo.visible = box !== null && gizmos;
      if (box) placeBox(selected, box, 0.25);
    },
    hover(box) {
      hovered.visible = box !== null;
      if (box) placeBox(hovered, box, 0.12);
    },
    outlineZone(rect, color = '#ffffff') {
      zoneLine.visible = rect !== null;
      if (!rect) return;
      const y = 0.12;
      zoneLine.geometry.dispose();
      zoneLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(rect.minX, y, rect.minZ),
        new THREE.Vector3(rect.maxX, y, rect.minZ),
        new THREE.Vector3(rect.maxX, y, rect.maxZ),
        new THREE.Vector3(rect.minX, y, rect.maxZ),
      ]);
      (zoneLine.material as THREE.LineBasicMaterial).color.set(color);
    },
    setGizmos(on) {
      gizmos = on;
      gizmo.visible = on && selectedBox !== null;
    },
    arc(a, b, lift) {
      const distance = a.distanceTo(b);
      const mid = a.clone().lerp(b, 0.5);
      mid.y = Math.max(a.y, b.y) + (lift ?? Math.min(40, 4 + distance * 0.35));
      const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
      return curve.getPoints(Math.max(16, Math.round(distance / 2)));
    },
    packet(points, color, seconds) {
      return new Promise((resolve) => {
        if (points.length < 2) {
          resolve();
          return;
        }
        const lengths = [0];
        for (let index = 1; index < points.length; index += 1) {
          const a = points[index - 1];
          const b = points[index];
          lengths.push((lengths[index - 1] ?? 0) + (a && b ? a.distanceTo(b) : 0));
        }
        const total = lengths[lengths.length - 1] ?? 0;
        const tint = new THREE.Color(color);
        const head = new THREE.Mesh(headGeometry, new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(4), toneMapped: false }));
        head.position.copy(points[0] ?? tmp);
        const trailPoints = Array.from({ length: 24 }, () => head.position.clone());
        const trail = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(trailPoints),
          new THREE.LineBasicMaterial({ color: tint.clone().multiplyScalar(2.5), transparent: true, opacity: 0.85, toneMapped: false }),
        );
        scene.add(head, trail);
        packets.push({ points, lengths, total, travelled: 0, speed: total / Math.max(0.2, seconds), head, trail, trailPoints, color: tint, done: resolve });
      });
    },
    ping(at, color, size = 1) {
      const mesh = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
      mesh.position.set(at.x, 0.15, at.z);
      mesh.userData.size = size;
      scene.add(mesh);
      pings.push({ mesh, age: 0, life: 1.1 });
    },
    clearPackets() {
      for (const packet of packets.splice(0)) {
        scene.remove(packet.head, packet.trail);
        packet.done();
      }
    },
    update(dt, camera) {
      // Gizmo keeps a constant size on screen.
      if (gizmo.visible && selectedBox) {
        selectedBox.getCenter(gizmo.position);
        gizmo.position.y = selectedBox.max.y + 0.4;
        const distance = camera.position.distanceTo(gizmo.position);
        gizmo.scale.setScalar(Math.max(0.6, distance * 0.045));
      }
      zonePulse += dt;
      (zoneLine.material as THREE.LineBasicMaterial).opacity = 0.55 + Math.sin(zonePulse * 3) * 0.35;

      for (let index = packets.length - 1; index >= 0; index -= 1) {
        const packet = packets[index];
        if (!packet) continue;
        packet.travelled = Math.min(packet.total, packet.travelled + packet.speed * dt);
        let segment = 1;
        while (segment < packet.lengths.length - 1 && (packet.lengths[segment] ?? 0) < packet.travelled) segment += 1;
        const a = packet.points[segment - 1];
        const b = packet.points[segment];
        if (a && b) {
          const start = packet.lengths[segment - 1] ?? 0;
          const span = (packet.lengths[segment] ?? 0) - start;
          packet.head.position.copy(a).lerp(b, span > 0 ? (packet.travelled - start) / span : 1);
        }
        packet.head.position.y += 0.25;
        packet.trailPoints.pop();
        packet.trailPoints.unshift(packet.head.position.clone());
        packet.trail.geometry.setFromPoints(packet.trailPoints);
        const pulse = 1 + Math.sin(performance.now() / 70) * 0.18;
        packet.head.scale.setScalar(pulse);
        if (packet.travelled >= packet.total) {
          scene.remove(packet.head, packet.trail);
          packet.trail.geometry.dispose();
          packets.splice(index, 1);
          packet.done();
        }
      }
      for (let index = pings.length - 1; index >= 0; index -= 1) {
        const ping = pings[index];
        if (!ping) continue;
        ping.age += dt;
        const t = ping.age / ping.life;
        const size = (ping.mesh.userData.size as number) ?? 1;
        ping.mesh.scale.setScalar((0.6 + t * 3.2) * size);
        (ping.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
        if (t >= 1) {
          scene.remove(ping.mesh);
          (ping.mesh.material as THREE.Material).dispose();
          pings.splice(index, 1);
        }
      }
    },
  };
}

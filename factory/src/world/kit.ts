// The building kit: unit shapes and a Merger that bakes many colored copies of them into one mesh.
// Machines, zone buildings, pipes, power and the landscape all build with it, so the whole map stays
// at a few draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const C = (hex: string): THREE.Color => new THREE.Color(hex);

export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
export const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
export const CONE = new THREE.ConeGeometry(0.5, 1, 20);
export const SPHERE = new THREE.SphereGeometry(0.5, 20, 14);

/** A triangular prism along x: a gable roof 1 long, 1 wide (z) and 1 high, standing on y = 0. */
export const GABLE = (() => {
  const shape = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.translate(0, 0, -0.5);
  geometry.rotateY(Math.PI / 2);
  return geometry;
})();

/** One tooth of a sawtooth roof along x: a steep glazed face toward -z (north), a slope down to +z. */
export const TOOTH = (() => {
  const shape = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(-0.5, 1)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.translate(0, 0, -0.5);
  geometry.rotateY(Math.PI / 2);
  return geometry;
})();

/** A barrel vault along x: half a cylinder, 1 long, 1 wide, 0.5 high, open at the ends. */
export const VAULT = (() => {
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true, -Math.PI / 2, Math.PI);
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
})();

/** A dome: the upper half of a sphere of diameter 1. */
export const DOME = new THREE.SphereGeometry(0.5, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);

/** A torus lying flat (for wheels, rims and rings), radius 0.5. */
export const RING = new THREE.TorusGeometry(0.5, 0.08, 8, 28);

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

export class Merger {
  private parts: THREE.BufferGeometry[] = [];

  get size(): number {
    return this.parts.length;
  }

  add(template: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): void {
    const geometry = (template.index ? template.toNonIndexed() : template.clone()) as THREE.BufferGeometry;
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
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

  /** A straight beam or pipe between two points. */
  beam(color: THREE.Color, a: THREE.Vector3, b: THREE.Vector3, r: number, low = true): void {
    const length = a.distanceTo(b);
    if (length < 1e-4) return;
    const geometry = (low ? CYL8 : CYL).toNonIndexed();
    geometry.deleteAttribute('uv');
    tmpQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpPos.subVectors(b, a).normalize());
    tmpMatrix.compose(tmpPos.addVectors(a, b).multiplyScalar(0.5), tmpQuat, tmpScale.set(r * 2, length, r * 2));
    geometry.applyMatrix4(tmpMatrix);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) colors.set([color.r, color.g, color.b], index * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(geometry);
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

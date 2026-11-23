// Walk mode: the factory in first person. The mouse looks around (with the pointer locked, or by
// dragging when the browser refuses the lock), WASD walks, Shift runs and Space jumps. The walker
// collides with machines, posts and tree trunks, steps onto anything knee-high, and can jump onto
// the small machines.

import * as THREE from 'three';

const EYE = 1.65;
const HEIGHT = 1.85;
const RADIUS = 0.35;
const STEP = 0.55;
const WALK = 6;
const RUN = 12;
const GRAVITY = 24;
const JUMP = 8;
const LOOK = 0.0022;

export interface Obstacle {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface WalkerOptions {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Machine footprints, as boxes standing on the ground. */
  boxes: () => Iterable<THREE.Box3>;
  /** Round obstacles: posts, columns, hubs and tree trunks. */
  posts: Obstacle[];
  /** How far from the center the walker may go. */
  limit: number;
  onChange(active: boolean): void;
  onLockChange(locked: boolean): void;
}

export interface Walker {
  readonly active: boolean;
  readonly locked: boolean;
  /** Where the walker's feet are. */
  readonly position: THREE.Vector3;
  enter(at: THREE.Vector3, yaw: number): void;
  exit(): void;
  update(dt: number): void;
}

export function createWalker(options: WalkerOptions): Walker {
  const { camera, canvas } = options;
  const position = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const keys = new Set<string>();
  let active = false;
  let locked = false;
  let grounded = true;
  let yaw = 0;
  let pitch = 0;
  let bob = 0;
  let saved = { fov: camera.fov, near: camera.near };

  const lock = (): void => {
    try {
      const request = canvas.requestPointerLock() as Promise<void> | undefined;
      // Without the lock, dragging the mouse still looks around.
      request?.catch?.(() => {});
    } catch {
      // Same: drag to look.
    }
  };

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    options.onLockChange(locked);
  });
  canvas.addEventListener('click', () => {
    if (active && !locked) lock();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!active || (!locked && (event.buttons & 1) === 0)) return;
    yaw -= event.movementX * LOOK;
    pitch = THREE.MathUtils.clamp(pitch - event.movementY * LOOK, -1.45, 1.45);
  });

  const typing = (event: KeyboardEvent): boolean => event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  window.addEventListener('keydown', (event) => {
    if (!active || typing(event) || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Escape') {
      // With the pointer locked, the browser takes Esc to free the mouse; the next Esc leaves.
      event.preventDefault();
      exit();
      return;
    }
    keys.add(event.code);
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    if (event.code === 'Space' && grounded) {
      velocity.y = JUMP;
      grounded = false;
    }
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());

  function enter(at: THREE.Vector3, facing: number): void {
    position.copy(at);
    velocity.set(0, 0, 0);
    yaw = facing;
    pitch = -0.08;
    grounded = true;
    saved = { fov: camera.fov, near: camera.near };
    camera.fov = 70;
    camera.near = 0.05;
    camera.updateProjectionMatrix();
    active = true;
    lock();
    options.onChange(true);
    place();
  }

  function exit(): void {
    if (!active) return;
    active = false;
    keys.clear();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    camera.fov = saved.fov;
    camera.near = saved.near;
    camera.updateProjectionMatrix();
    options.onChange(false);
  }

  function place(): void {
    camera.position.set(position.x, position.y + EYE + Math.sin(bob) * 0.045, position.z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  // Pushes the walker out of anything taller than a step.
  function collide(): void {
    const feet = position.y;
    for (const box of options.boxes()) {
      if (box.max.y <= feet + STEP || box.min.y >= feet + HEIGHT) continue;
      const cx = THREE.MathUtils.clamp(position.x, box.min.x, box.max.x);
      const cz = THREE.MathUtils.clamp(position.z, box.min.z, box.max.z);
      const dx = position.x - cx;
      const dz = position.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= RADIUS * RADIUS) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        position.x += (dx / d) * (RADIUS - d);
        position.z += (dz / d) * (RADIUS - d);
      } else {
        // Inside the box: leave by the nearest side.
        const exits = [position.x - box.min.x, box.max.x - position.x, position.z - box.min.z, box.max.z - position.z];
        const nearest = exits.indexOf(Math.min(...exits));
        if (nearest === 0) position.x = box.min.x - RADIUS;
        if (nearest === 1) position.x = box.max.x + RADIUS;
        if (nearest === 2) position.z = box.min.z - RADIUS;
        if (nearest === 3) position.z = box.max.z + RADIUS;
      }
    }
    for (const post of options.posts) {
      if (post.h <= feet + STEP) continue;
      const dx = position.x - post.x;
      const dz = position.z - post.z;
      const reach = RADIUS + post.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;
      const d = Math.sqrt(d2) || 1e-4;
      position.x = post.x + (dx / d) * reach;
      position.z = post.z + (dz / d) * reach;
    }
  }

  // The highest thing under the walker that it can stand on.
  function support(): number {
    let floor = 0;
    const feet = position.y;
    const r = RADIUS * 0.6;
    for (const box of options.boxes()) {
      if (box.max.y > feet + STEP) continue;
      if (position.x + r < box.min.x || position.x - r > box.max.x || position.z + r < box.min.z || position.z - r > box.max.z) continue;
      floor = Math.max(floor, box.max.y);
    }
    for (const post of options.posts) {
      if (post.h > feet + STEP) continue;
      if (Math.hypot(position.x - post.x, position.z - post.z) < post.r + r) floor = Math.max(floor, post.h);
    }
    return floor;
  }

  const wish = new THREE.Vector3();
  function update(dt: number): void {
    if (!active) return;
    const pressed = (...codes: string[]): number => (codes.some((code) => keys.has(code)) ? 1 : 0);
    const forward = pressed('KeyW', 'ArrowUp') - pressed('KeyS', 'ArrowDown');
    const strafe = pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft');
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK;
    wish.set(-Math.sin(yaw) * forward + Math.cos(yaw) * strafe, 0, -Math.cos(yaw) * forward - Math.sin(yaw) * strafe);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    const grip = Math.min(1, dt * (grounded ? 12 : 3));
    velocity.x += (wish.x - velocity.x) * grip;
    velocity.z += (wish.z - velocity.z) * grip;
    velocity.y -= GRAVITY * dt;

    position.x += velocity.x * dt;
    position.z += velocity.z * dt;
    collide();
    collide();
    const reach = Math.hypot(position.x, position.z);
    if (reach > options.limit) {
      position.x *= options.limit / reach;
      position.z *= options.limit / reach;
    }

    position.y += velocity.y * dt;
    const floor = support();
    if (position.y <= floor) {
      position.y = floor;
      velocity.y = 0;
      grounded = true;
    } else {
      grounded = position.y - floor < 0.02;
    }

    const moving = Math.hypot(velocity.x, velocity.z);
    if (grounded && moving > 0.5) bob += dt * moving * 1.6;
    else bob += (Math.round(bob / Math.PI) * Math.PI - bob) * Math.min(1, dt * 8);
    place();
  }

  return {
    get active() {
      return active;
    },
    get locked() {
      return locked;
    },
    position,
    enter,
    exit,
    update,
  };
}

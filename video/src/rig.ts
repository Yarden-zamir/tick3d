// The camera helpers of every video: a shot, a point on an orbit around the tower, the easing curves, and the
// framing of a shot in both crops.
import { type PerspectiveCamera, Vector3 } from 'three';
import { Easing, interpolate } from 'remotion';

export type Shot = {
  position: Vector3;
  target: Vector3;
  up: Vector3;
  // The vertical field of view of the centre square, in degrees. Both crops show the same square.
  fov: number;
  // The end card: the zoom of the picture, and its shift up in halves of the square.
  zoom: number;
  lift: number;
};

export const WORLD_UP = new Vector3(0, 1, 0);
export const DEG = Math.PI / 180;
// The game shows the tower at a tilt of 62° (TOWER_TILT in src/board/board.ts): the camera is 28° above the boards.
const TILT = 62;
export const ELEVATION = 90 - TILT;
// The home view: from the side of corner 63, a little off the diagonal, so the depth reads.
export const HOME_AZIMUTH = 30;
export const HOME_DISTANCE = 17;
export const HOME_FOV = 30;

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
// Remotion's easing curves, bound, so the lint sees plain functions.
export const cubic = (t: number) => Easing.cubic(t);
export const quad = (t: number) => Easing.quad(t);
export const sine = (t: number) => Easing.sin(t);
export const ease = (t: number, from: number, to: number, easing = Easing.inOut(cubic)) => interpolate(t, [0, 1], [from, to], { ...clamp, easing });

// A point on a sphere around `target`: azimuth from +z towards +x, elevation above the boards.
export function orbit(target: Vector3, azimuth: number, elevation: number, distance: number): Vector3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return new Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).multiplyScalar(distance).add(target);
}

export const shot = (position: Vector3, target: Vector3, fov = HOME_FOV, up = WORLD_UP.clone()): Shot => ({ position, target, up, fov, zoom: 1, lift: 0 });

// Points `camera` along `view` for a frame of `width` × `height`. Both crops show the same centre square: the
// field of view of a shot is the one of the square, so a tall frame widens it.
export function aim(camera: PerspectiveCamera, view: Shot, width: number, height: number): void {
  camera.position.copy(view.position);
  camera.up.copy(view.up);
  camera.lookAt(view.target);
  const aspect = width / height;
  const square = (view.fov * Math.PI) / 180;
  camera.fov = aspect >= 1 ? view.fov : (2 * Math.atan(Math.tan(square / 2) / aspect) * 180) / Math.PI;
  camera.aspect = aspect;
  camera.zoom = view.zoom;
  camera.setViewOffset(width, height, 0, (view.lift * Math.min(width, height)) / 2, width, height);
  camera.updateProjectionMatrix();
}

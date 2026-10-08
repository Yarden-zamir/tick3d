// The camera rig: one shot for each camera kind of beats.json. A shot is a function of the frame only.
import { Vector3 } from 'three';
import { Easing, interpolate } from 'remotion';
import { BEATS, barAt, eventsOf, since } from './timeline.ts';
import { LAYER_GAP, TOWER_CENTER, cellCenter } from './layout.ts';

type Bar = ReturnType<typeof barAt>;

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

const WORLD_UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
// The game shows the tower at a tilt of 62° (TOWER_TILT in src/board/board.ts): the camera is 28° above the boards.
const TILT = 62;
const ELEVATION = 90 - TILT;
// The home view: from the side of corner 63, a little off the diagonal, so the depth reads.
const HOME_AZIMUTH = 30;
const HOME_DISTANCE = 17;
const HOME_FOV = 30;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
// Remotion's easing curves, bound, so the lint sees plain functions.
const cubic = (t: number) => Easing.cubic(t);
const quad = (t: number) => Easing.quad(t);
const sine = (t: number) => Easing.sin(t);
const linear = (t: number) => t;
const ease = (t: number, from: number, to: number, easing = Easing.inOut(cubic)) => interpolate(t, [0, 1], [from, to], { ...clamp, easing });

// A point on a sphere around `target`: azimuth from +z towards +x, elevation above the boards.
function orbit(target: Vector3, azimuth: number, elevation: number, distance: number): Vector3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return new Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).multiplyScalar(distance).add(target);
}

const shot = (position: Vector3, target: Vector3, fov = HOME_FOV, up = WORLD_UP.clone()): Shot => ({ position, target, up, fov, zoom: 1, lift: 0 });

// A short jolt of the camera after each layer slam and after the winning move: a damped bounce, down first.
function jolt(frame: number): number {
  const hits = [...eventsOf('layer-slam').map((event) => event.at), BEATS.moves.at(-1)?.at ?? 0];
  let offset = 0;
  for (const at of hits) {
    const t = since(frame, at);
    if (t >= 0 && t < 4) offset -= 0.22 * Math.exp(-t * 1.4) * Math.cos(t * 3.2);
  }
  return offset;
}

const WIN_LINE = BEATS.game.line;
const lineStart = cellCenter(WIN_LINE[0]);
const lineEnd = cellCenter(WIN_LINE[3]);
const lineDirection = lineEnd.clone().sub(lineStart).normalize();
const lineSide = new Vector3().crossVectors(lineDirection, WORLD_UP).normalize();
const lineUp = new Vector3().crossVectors(lineSide, lineDirection).normalize();

export function cameraAt(frame: number, bar: Bar): Shot {
  const u = since(frame, bar.start) / 16;
  switch (bar.camera) {
    case 'slam': {
      const target = TOWER_CENTER.clone().add(new Vector3(0, jolt(frame), 0));
      return shot(orbit(target, HOME_AZIMUTH, ELEVATION, HOME_DISTANCE), target);
    }
    case 'dive': {
      // Straight down the centre axis, through the seam of cells 5, 6, 9 and 10. From high above, the four boards
      // stack into a tunnel. The camera reaches layer 3 on beat 3 and threads layers 2, 1 and 0 on beat 4,
      // while it rolls a quarter turn.
      const beats = u * 4;
      const height = interpolate(beats, [0, 2.6, 3.1, 3.55, 4], [3 * LAYER_GAP + 12, 3 * LAYER_GAP + 0.3, 2 * LAYER_GAP, LAYER_GAP, -0.4], {
        ...clamp,
        easing: Easing.inOut(sine),
      });
      // It starts off the axis, so the stack of boards shows, and swings onto the axis before layer 3.
      const away = ease(beats / 2.6, 9, 0, Easing.inOut(quad));
      const roll = u * 90 * DEG;
      const position = new Vector3(away * 0.7, height, away * 0.7);
      const onAxis = 1 - away / 9;
      const target = TOWER_CENTER.clone().lerp(new Vector3(0, height - 8, 0), onAxis);
      const up = WORLD_UP.clone().lerp(new Vector3(Math.sin(roll), 0, Math.cos(roll)), onAxis).normalize();
      return shot(position, target, ease(beats / 3, 40, 80, Easing.in(quad)), up);
    }
    case 'orbit': {
      // Out from under layer 0 and up into a half turn around the tower.
      const elevation = ease(u, -40, ELEVATION, Easing.out(cubic));
      const distance = ease(u, 7, HOME_DISTANCE, Easing.out(quad));
      const azimuth = ease(u, HOME_AZIMUTH, HOME_AZIMUTH + 180);
      const fov = ease(u, 60, HOME_FOV, Easing.out(cubic));
      return shot(orbit(TOWER_CENTER, azimuth, elevation, distance), TOWER_CENTER.clone(), fov);
    }
    case 'push': {
      // In to corner 0, where the double threat starts.
      const corner = cellCenter(WIN_LINE[0]);
      const target = TOWER_CENTER.clone().lerp(corner, ease(u, 0, 0.55));
      const azimuth = ease(u, HOME_AZIMUTH + 180, 225);
      return shot(orbit(target, azimuth, ease(u, ELEVATION, 20), ease(u, HOME_DISTANCE, 10.5)), target);
    }
    case 'ride': {
      // The win: the camera sees the winning line side on, a diagonal across the frame, while the X lands and
      // the 4 cells light. When the beam fires, the camera swoops in beside it and races its front out
      // through corner 63, with a slow roll.
      const beam = eventsOf('beam')[0];
      const k = beam === undefined ? 0 : since(frame, beam.at) / (bar.start + 16 - beam.at);
      const middle = lineStart.clone().lerp(lineEnd, 0.5);
      const profile = shot(middle.clone().addScaledVector(lineSide, ease(u, 13, 11.5, linear)).addScaledVector(lineUp, 3), middle);
      const length = lineStart.distanceTo(lineEnd);
      const front = ease(k, 0, length + 3, Easing.in(quad));
      const roll = ease(k, 0, 30 * DEG, Easing.inOut(quad));
      const up = lineUp.clone().applyAxisAngle(lineDirection, roll);
      const point = lineStart.clone().addScaledVector(lineDirection, front);
      const ride = shot(point.clone().addScaledVector(lineSide, 2.6).addScaledVector(up, 1.5).addScaledVector(lineDirection, -2.2), point.clone().addScaledVector(lineDirection, 1.2), 55, up);
      const w = ease(k, 0, 1, Easing.inOut(cubic));
      return {
        ...ride,
        position: profile.position.clone().lerp(ride.position, w),
        target: profile.target.clone().lerp(ride.target, w),
        up: profile.up.clone().lerp(ride.up, w).normalize(),
        fov: interpolate(w, [0, 1], [profile.fov, ride.fov]),
      };
    }
    case 'pull-back': {
      // Back out of corner 63 to the whole tower, which turns once.
      const target = lineEnd.clone().lerp(TOWER_CENTER, ease(u, 0, 1, Easing.out(cubic)));
      const azimuth = ease(u, 45, HOME_AZIMUTH + 360, Easing.inOut(cubic));
      const distance = ease(u, 2.5, HOME_DISTANCE, Easing.out(cubic));
      return shot(orbit(target, azimuth, ease(u, 40, ELEVATION), distance), target, ease(u, 60, HOME_FOV, Easing.out(cubic)));
    }
    case 'settle': {
      // The end card: the tower shrinks into the top half of the centre square and drifts on.
      const first = BEATS.bars.find((b) => b.camera === 'settle') ?? bar;
      const t = since(frame, first.start);
      const shrink = ease(t / 3, 0, 1, Easing.out(Easing.back(1.6)));
      const target = TOWER_CENTER.clone().add(new Vector3(0, jolt(frame) * 0.5, 0));
      const view = shot(orbit(target, HOME_AZIMUTH + t * 0.6, ELEVATION, HOME_DISTANCE), target);
      return { ...view, zoom: interpolate(shrink, [0, 1], [1, 0.58]), lift: interpolate(shrink, [0, 1], [0, 0.46]) };
    }
  }
}

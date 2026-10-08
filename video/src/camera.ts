// The camera rig: one shot for each camera kind of beats.json. A shot is a function of the frame only.
import { Vector3 } from 'three';
import { Easing, interpolate } from 'remotion';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, barAt, eventsOf, frameOf, since } from './timeline.ts';
import { TOWER_CENTER, cellCenter } from './layout.ts';

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
const ease = (t: number, from: number, to: number, easing = Easing.inOut(cubic)) => interpolate(t, [0, 1], [from, to], { ...clamp, easing });

// A point on a sphere around `target`: azimuth from +z towards +x, elevation above the boards.
function orbit(target: Vector3, azimuth: number, elevation: number, distance: number): Vector3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return new Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).multiplyScalar(distance).add(target);
}

const shot = (position: Vector3, target: Vector3, fov = HOME_FOV, up = WORLD_UP.clone()): Shot => ({ position, target, up, fov, zoom: 1, lift: 0 });

const hits = () => [...eventsOf('layer-slam').map((event) => event.at), BEATS.moves.at(-1)?.at ?? 0];

// A short jolt of the camera after each layer slam and after the winning move: a damped bounce, down first.
function jolt(frame: number): number {
  let offset = 0;
  for (const at of hits()) {
    const t = since(frame, at);
    if (t >= 0 && t < 4) offset -= 0.22 * Math.exp(-t * 1.4) * Math.cos(t * 3.2);
  }
  return offset;
}

// A shake of the camera on the frame of a hit and the one after it, so the impact frame reads as a hit.
function shake(frame: number): Vector3 {
  for (const at of hits()) {
    const f = frame - frameOf(at);
    if (f === 0) return new Vector3(0.35, -0.3, 0);
    if (f === 1) return new Vector3(-0.18, 0.14, 0);
  }
  return new Vector3();
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
      // The gaze starts on layer 3, the first to land, and sinks to the centre as the tower builds.
      const target = TOWER_CENTER.clone().add(new Vector3(0, ease(u, 1.3, 0, Easing.out(cubic)) + jolt(frame), 0));
      return shot(orbit(target, HOME_AZIMUTH, ELEVATION, HOME_DISTANCE).add(shake(frame)), target);
    }
    case 'dive': {
      // A corkscrew down past the tower: from high above, the camera spirals a third of a turn around the tower
      // while it sinks, with the gaps between the layers open to the lens, so every move shows as it lands. In
      // the last beat it plunges under layer 0, where the orbit of bar 3 picks it up.
      // The gaps between the layers open below about 28° (the tilt of the game), so the camera drops to that
      // elevation by the second beat and keeps sinking.
      const elevation = interpolate(u, [0, 0.25, 0.85, 1], [30, 22, 10, -40], { ...clamp, easing: Easing.inOut(sine) });
      const distance = ease(u, 11, 7, Easing.inOut(quad));
      const azimuth = ease(u, HOME_AZIMUTH - 120, HOME_AZIMUTH, Easing.inOut(sine));
      const target = TOWER_CENTER.clone().add(new Vector3(0, ease(u, 1.2, -0.8, Easing.inOut(sine)), 0));
      const position = orbit(target, azimuth, elevation, distance);
      // A roll that peaks mid-bar and settles before the plunge.
      const roll = Math.sin(u * Math.PI) * 18 * DEG;
      const up = WORLD_UP.clone().applyAxisAngle(target.clone().sub(position).normalize(), roll);
      return shot(position, target, ease(u, 34, 60, Easing.in(quad)), up);
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
      // In to corner 0, where the double threat starts. The picture sits a little low, so the text line has
      // clear page above the tower.
      const corner = cellCenter(WIN_LINE[0]);
      const target = TOWER_CENTER.clone().lerp(corner, ease(u, 0, 0.55));
      const azimuth = ease(u, HOME_AZIMUTH + 180, 225);
      return { ...shot(orbit(target, azimuth, ease(u, ELEVATION, 20), ease(u, HOME_DISTANCE, 13)), target), lift: -0.3 };
    }
    case 'ride': {
      // The win: from the downbeat the camera stands square to the plane of the winning diagonal, at the tilt of
      // the game, so the four cells read as one rising line while they light. Once the beam is joined, the
      // camera drops onto the line, 1 cell beside it, and races its glow out through corner 63 with a roll.
      const beam = eventsOf('beam')[0];
      const rideFrom = beam === undefined ? bar.start : beam.at + beam.line.length;
      const k = since(frame, rideFrom) / (bar.start + SIXTEENTHS_PER_BAR - rideFrom);
      const middle = lineStart.clone().lerp(lineEnd, 0.5);
      const square = middle.clone().addScaledVector(lineSide, Math.cos(ELEVATION * DEG) * 16).addScaledVector(WORLD_UP, Math.sin(ELEVATION * DEG) * 16);
      const profile = shot(square, middle.clone().add(new Vector3(0, jolt(frame) * 0.6, 0)));
      if (k <= 0) return profile;
      const length = lineStart.distanceTo(lineEnd);
      const front = ease(k, -1.5, length + 2.5, Easing.in(quad));
      const roll = ease(k, 0, 25 * DEG, Easing.inOut(quad));
      const beside = lineUp.clone().applyAxisAngle(lineDirection, roll);
      const point = lineStart.clone().addScaledVector(lineDirection, front);
      const ride = shot(point.clone().addScaledVector(beside, 1).addScaledVector(lineDirection, -1.6), point.clone().addScaledVector(lineDirection, 2.5), 48, beside);
      const w = ease(k / 0.25, 0, 1, Easing.inOut(cubic));
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
      const view = shot(orbit(target, HOME_AZIMUTH + t * 0.6, ELEVATION, HOME_DISTANCE).addScaledVector(shake(frame), 0.5), target);
      return { ...view, zoom: interpolate(shrink, [0, 1], [1, 0.58]), lift: interpolate(shrink, [0, 1], [0, 0.46]) };
    }
  }
}

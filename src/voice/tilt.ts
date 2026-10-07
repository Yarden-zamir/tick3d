// Tilt fine-tuning: a small front-to-back tilt of the device nudges the place of the voice on the scale.
// The voice gives the coarse place, and the tilt moves it a few steps up or down. The engine (engine.ts)
// reads DeviceOrientationEvent `beta` and takes the angle at the start as neutral. These functions are pure.
//
// Direction: the top edge of the device toward you (a larger beta, toward upright) moves the place up the
// scale. The top edge away from you (toward flat) moves it down.
//
// Limit: beta is the front-to-back tilt only while the device stands in portrait, between flat and upright.
// Held flat, beta turns into a mix with the side tilt near the flat pose. Upside down, beta jumps at
// ±180°. In landscape, the front-to-back tilt is gamma and not beta. The players of this game hold a
// phone in portrait to see the board, so beta is enough. Revisit this when players use landscape or report a
// nudge that jumps: then take the tilt from the gravity vector of DeviceMotionEvent and screen.orientation.

// Turn tilt on or off, and the largest nudge in steps (cells of the 64-step scale).
export type TiltSettings = { on: boolean; steps: number };

export const DEFAULT_TILT: TiltSettings = { on: true, steps: 4 };
export const MAX_TILT_STEPS = 8;
// No nudge within this angle from neutral, in degrees, so a steady hand does not move the place.
export const TILT_DEAD_ZONE = 2;
// The full nudge at this angle from neutral, in degrees. A larger angle gives no more.
export const TILT_FULL = 10;
// The nudge follows the tilt with this time constant, in milliseconds.
export const TILT_SMOOTH_MS = 150;

// The angle from `neutral` to `beta`, in degrees from -180 to 180: the short way around.
function angleFrom(neutral: number, beta: number): number {
  const delta = (((beta - neutral) % 360) + 540) % 360 - 180;
  return delta === -180 ? 180 : delta;
}

// The nudge in steps for the tilt `beta` (degrees), with `neutral` as zero: 0 in the dead zone, then a
// straight line up to ±`steps` at TILT_FULL.
export function tiltTarget(beta: number, neutral: number, steps: number): number {
  if (!Number.isFinite(beta) || !Number.isFinite(neutral)) throw new RangeError(`not an angle: ${beta}, ${neutral}`);
  if (!Number.isFinite(steps) || steps < 0) throw new RangeError(`not a step count: ${steps}`);
  const delta = angleFrom(neutral, beta);
  const share = Math.min(1, Math.max(0, (Math.abs(delta) - TILT_DEAD_ZONE) / (TILT_FULL - TILT_DEAD_ZONE)));
  // A plain 0 in the dead zone, not -0.
  return share === 0 ? 0 : Math.sign(delta) * share * steps;
}

// Moves `current` toward `target` for `elapsedMs`: an exponential follow with TILT_SMOOTH_MS, so one shaky
// reading moves the nudge only a little.
export function smoothToward(current: number, target: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError(`not a frame time: ${elapsedMs}`);
  return current + (target - current) * (1 - Math.exp(-elapsedMs / TILT_SMOOTH_MS));
}

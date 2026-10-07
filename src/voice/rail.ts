// The pitch rail: the whole range as a strip, low at the left. It shows the four row bands, a tick for
// each layer and each column, a cursor at the pitch now, the sticky band around the lit cell, the tilt
// nudge (an arrow from the place of the voice alone to the cursor), and an optional target cell. rail.css draws it. The places come from positionOf in mapping.ts (0 to STEPS).
import './rail.css';
import { type PitchMap, STEPS, frequencyAt } from './mapping.ts';
import type { Held } from './sticky.ts';

export type Rail = {
  cursor: HTMLElement;
  band: HTMLElement;
  tilt: HTMLElement;
  target: HTMLElement;
  labels: readonly HTMLElement[];
};

const percent = (position: number): string => `${(Math.min(STEPS, Math.max(0, position)) / STEPS) * 100}%`;

function part(className: string, parent: HTMLElement): HTMLElement {
  const child = document.createElement('i');
  child.className = className;
  parent.append(child);
  return child;
}

export function buildRail(root: HTMLElement): Rail {
  root.replaceChildren();
  const track = document.createElement('div');
  track.className = 'rail-track';
  // Row 4 is the lowest part of the range, so it comes first from the left.
  for (const row of [4, 3, 2, 1]) {
    const band = document.createElement('span');
    band.className = 'rail-row';
    band.textContent = `Row ${row}`;
    track.append(band);
  }
  const target = part('rail-target', track);
  const band = part('rail-band', track);
  const tilt = part('rail-tilt', track);
  const cursor = part('rail-cursor', track);
  tilt.hidden = true;
  target.hidden = true;
  band.hidden = true;
  cursor.hidden = true;
  const scale = document.createElement('div');
  scale.className = 'rail-labels';
  // A label at each row border: the frequency in Hz.
  const labels = [0, 1, 2, 3, 4].map((index) => {
    const label = document.createElement('span');
    label.style.left = percent((index * STEPS) / 4);
    scale.append(label);
    return label;
  });
  root.append(track, scale);
  return { cursor, band, tilt, target, labels };
}

export function showRailRange(rail: Rail, map: PitchMap): void {
  rail.labels.forEach((label, index) => {
    label.textContent = `${Math.round(frequencyAt((index * STEPS) / 4, map))}`;
  });
}

// A nudge below this many steps does not show, so the arrow does not flicker at the dead zone.
const TILT_SHOWN = 0.1;

// `position` is the pitch now after the tilt, or null when there is no clear pitch. `margin` is the sticky
// margin of the held step, in steps. `tilt` is the tilt nudge in `position` (VoiceFrame.tilt).
export function showRailPitch(rail: Rail, position: number | null, held: Held | null, margin: number, tilt: number | null): void {
  rail.cursor.hidden = position === null;
  const nudge = position === null || tilt === null || Math.abs(tilt) < TILT_SHOWN ? null : tilt;
  rail.tilt.hidden = nudge === null;
  if (position !== null && nudge !== null) {
    const from = Math.min(position, position - nudge);
    rail.tilt.dataset.way = nudge > 0 ? 'up' : 'down';
    rail.tilt.style.left = percent(from);
    rail.tilt.style.width = `calc(${percent(from + Math.abs(nudge))} - ${percent(from)})`;
  }
  rail.band.hidden = held === null;
  if (position !== null) rail.cursor.style.left = percent(position);
  if (held !== null) {
    rail.band.style.left = percent(held.step - margin);
    rail.band.style.width = `calc(${percent(held.step + 1 + margin)} - ${percent(held.step - margin)})`;
  }
}

// `step` is the step of the target cell (stepOfCell in mapping.ts), or null for no target.
export function showRailTarget(rail: Rail, step: number | null): void {
  rail.target.hidden = step === null;
  if (step === null) return;
  rail.target.style.left = percent(step);
  rail.target.style.width = percent(1);
}

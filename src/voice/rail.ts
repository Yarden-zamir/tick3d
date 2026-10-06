// The pitch rail: the whole range as a strip, low at the left. It shows the four row bands, a tick for
// each layer and each column, a cursor at the pitch now, the sticky band around the lit cell, and an
// optional target cell. input.css draws it. The places come from positionOf in mapping.ts (0 to STEPS).
import { frequencyAt, type Range, STEPS } from './mapping.ts';
import type { Held } from './sticky.ts';

export type Rail = {
  cursor: HTMLElement;
  band: HTMLElement;
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
  const cursor = part('rail-cursor', track);
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
  return { cursor, band, target, labels };
}

export function showRailRange(rail: Rail, range: Range): void {
  rail.labels.forEach((label, index) => {
    label.textContent = `${Math.round(frequencyAt((index * STEPS) / 4, range))}`;
  });
}

// `position` is the pitch now, or null when there is no clear pitch. `margin` is the sticky margin of the
// held step, in steps.
export function showRailPitch(rail: Rail, position: number | null, held: Held | null, margin: number): void {
  rail.cursor.hidden = position === null;
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

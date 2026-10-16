// The camera of the tutorial: the view of each section, with a slow drift around the tower, and a turn from
// one view to the next (plan.ts `arrive`). A shot is a function of the frame only.
import { Easing, interpolate } from 'remotion';
import { since } from '../grid.ts';
import { TOWER_CENTER } from '../layout.ts';
import { type Shot, ease, orbit, shot } from '../rig.ts';
import { DRIFT_PER_S16, SECTIONS, type Section, dragShare, sectionAt } from './plan.ts';

// The sixteenths of a turn before a section ('lead') and after its start ('land').
const LEAD = 4;
const LAND = 3;

type View = Section['view'];

// The turn of the drags of a section at `s16`, in degrees, with the easing of the finger mark (dragShare).
const dragTurn = (section: Section, s16: number): number =>
  section.events.reduce((sum, event) => (event.kind === 'drag' ? sum + event.turn * dragShare(event, s16) : sum), 0);

const viewAt = (section: Section, s16: number): View => ({ ...section.view, azimuth: section.view.azimuth + DRIFT_PER_S16 * (s16 - section.start) + dragTurn(section, s16) });

function blend(a: View, b: View, w: number): View {
  const mix = (from: number, to: number) => interpolate(w, [0, 1], [from, to]);
  return { azimuth: mix(a.azimuth, b.azimuth), elevation: mix(a.elevation, b.elevation), distance: mix(a.distance, b.distance), zoom: mix(a.zoom, b.zoom), lift: mix(a.lift, b.lift) };
}

const toShot = (view: View): Shot => ({ ...shot(orbit(TOWER_CENTER, view.azimuth, view.elevation, view.distance), TOWER_CENTER.clone()), zoom: view.zoom, lift: view.lift });

export function shotAt(frame: number): Shot {
  const section = sectionAt(frame);
  const index = SECTIONS.indexOf(section);
  const s16 = since(frame, 0);
  const before = SECTIONS[index - 1];
  const next = SECTIONS[index + 1];
  if (section.arrive === 'land' && before !== undefined) {
    const k = since(frame, section.start) / LAND;
    return toShot(blend(viewAt(before, s16), viewAt(section, s16), ease(k, 0, 1, Easing.out(Easing.back(1.6)))));
  }
  if (next !== undefined && next.arrive === 'lead' && s16 >= next.start - LEAD) {
    return toShot(blend(viewAt(section, s16), viewAt(next, next.start), ease((s16 - (next.start - LEAD)) / LEAD, 0, 1)));
  }
  return toShot(viewAt(section, s16));
}

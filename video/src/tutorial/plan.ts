// The plan of the tutorial "How to win": its sections, what each one shows, and when, on the beat grid of
// src/grid.ts (sixteenths of the 136 BPM song). The numbers on screen come from the game code (lines.ts).
// It comes at two paces: 'long' (40 s, slow enough to read every label) and 'short' (27.5 s). TUTORIAL_PACE picks
// one; scripts/tutorial.ts passes it into the render browser. creative/tutorial.md explains the plan.
import { LINES, type Line, linesThrough, toCoords } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import type { Word } from '../lettering.ts';
import { ELEVATION, HOME_AZIMUTH, HOME_DISTANCE } from '../rig.ts';
import { type Kind, MOST_LINES, STRONG_CELLS, keeps, linesOf } from './lines.ts';

export const PACES = ['long', 'short'] as const;
export type Pace = (typeof PACES)[number];

// Where the camera stands: a point on an orbit around the centre of the tower. `zoom` and `lift` frame the
// picture in the centre square (rig.ts): a lift below 0 moves the tower down, under the label.
type View = { azimuth: number; elevation: number; distance: number; zoom: number; lift: number };

// Things that happen at a sixteenth. They show until the end of their section, the strong cells to the end.
type TutorialEvent =
  // A layer of the tower bumps. Sound: the Classic note of the layer.
  | { kind: 'layer-pulse'; at: number; layer: number }
  // An X drops on each cell of `line`, one every `gap` sixteenths, and a beam joins them `gap` after the last.
  // Sound: a soft note per cell, rising.
  | { kind: 'line'; at: number; gap: number; line: Line }
  // The lines of `lines`, all of the kind `of`, flash, then stay faint. The counter adds them. Sound: a soft chord.
  // Together the sets hold every line of the game once.
  | { kind: 'set'; at: number; of: Kind; lines: readonly Line[] }
  // Every line flashes, one kind per sixteenth. Sound: a note per kind, rising.
  | { kind: 'all'; at: number }
  // The cell lights, then each line through it, one every `gap` sixteenths. Sound: a note per line, rising.
  | { kind: 'through'; at: number; gap: number; cell: number }
  // The strong cells light: the corners at `at`, the core 4 sixteenths later. Sound: a soft chord on each.
  | { kind: 'strong'; at: number }
  // The win jingle of the game, one note per sixteenth.
  | { kind: 'jingle'; at: number }
  // The end card of the spot (lettering.ts endCard): the wordmark, the URL suffix, the call to action and the
  // store badges, each at its own sixteenth.
  | { kind: 'end-card'; at: number; words: readonly Word[] }
  // The final chord, to the end.
  | { kind: 'final-chord'; at: number };

// The label above the tower: a plain line, and a sticker under it that slams in at `stickerAt`. It shows until
// the next label of its section, or the end of the section.
type Label = { at: number; text: string; stickerAt: number; sticker: string };

export type Section = {
  name: string;
  start: number;
  end: number;
  view: View;
  // How the camera reaches the view: 'lead' turns in the 4 sixteenths before the start, so the section opens on
  // its view; 'land' moves in the 3 sixteenths after it, with an overshoot (the end card).
  arrive: 'lead' | 'land';
  labels: readonly Label[];
  // The running count of the lines shows under the tower.
  counter: boolean;
  events: readonly TutorialEvent[];
};

const view = (azimuth: number, elevation: number, distance = HOME_DISTANCE, zoom = 0.86, lift = -0.08): View => ({ azimuth, elevation, distance, zoom, lift });

// The space diagonals in pairs that cross in one vertical plane through the cube: the plane of corners 0 and 63
// (row = column), and the plane of corners 3 and 60 (row + column = 3). Each pair reads as an X from square on.
const spacePair = (onPlane: (row: number, column: number) => boolean) =>
  linesOf('space-diagonal').filter((line) => line.every((cell) => onPlane(toCoords(cell).row, toCoords(cell).column)));

// A cell on 4 lines, on the front edge of the top layer.
const OTHER_CELL = 61;

// The timing of a pace, in sixteenths. Each section starts where the one before it ends; its events and labels
// count from its start. A count (the sticker of a label) comes `count` after its label.
type Timing = {
  seconds: number;
  // A kind of line: the section length, one example cell per `cellGap`, and the set of lines at `set`.
  kind: { length: number; cellGap: number; count: number; set: number };
  // "4 in a row / wins.", then "Rows" at `label` with its set.
  rows: { length: number; label: number; count: number };
  all: { length: number; count: number };
  // Corner 63 and its 7 lines, one per `gap`, then core cell 42 at `second`.
  strong: { length: number; gap: number; second: number; count: number };
  other: { length: number; gap: number; count: number };
  take: { length: number; count: number; jingle: number };
};

const TIMINGS: Readonly<Record<Pace, Timing>> = {
  // Slow enough to read every label and to follow every example (maintainer feedback on #119).
  long: {
    seconds: 40,
    kind: { length: 24, cellGap: 2, count: 6, set: 12 },
    rows: { length: 40, label: 20, count: 4 },
    all: { length: 24, count: 6 },
    strong: { length: 40, gap: 2, second: 20, count: 6 },
    other: { length: 24, gap: 4, count: 6 },
    take: { length: 24, count: 10, jingle: 12 },
  },
  // One bar for each kind of line.
  short: {
    seconds: 27.5,
    kind: { length: 16, cellGap: 1, count: 8, set: 8 },
    rows: { length: 32, label: 16, count: 0 },
    all: { length: 16, count: 2 },
    strong: { length: 16, gap: 1, second: 8, count: 2 },
    other: { length: 16, gap: 2, count: 2 },
    take: { length: 16, count: 8, jingle: 8 },
  },
};

// The sections of a pace, back to back from 0. The rising and the space diagonals are the hard kinds, so each gets
// 2 sections, each with its own example and half of the set, seen square on.
function sectionsOf(t: Timing, end: number): Section[] {
  const sections: Section[] = [];
  const add = (length: number, make: (start: number) => Omit<Section, 'start' | 'end'>) => {
    const start = sections.at(-1)?.end ?? 0;
    sections.push({ ...make(start), start, end: start + length });
  };
  const kind = (name: string, of: Kind, text: string, line: Line, where: View, lines = linesOf(of)) =>
    add(t.kind.length, (start) => ({
      name,
      view: where,
      arrive: 'lead',
      labels: [{ at: start, text, stickerAt: start + t.kind.count, sticker: `+${lines.length}` }],
      counter: true,
      events: [
        { kind: 'line', at: start, gap: t.kind.cellGap, line },
        { kind: 'set', at: start + t.kind.set, of, lines },
      ],
    }));

  add(16, () => ({
    name: 'title',
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: 0, text: 'How to', stickerAt: 4, sticker: 'win' }],
    counter: false,
    events: [0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse', at: layer * 4, layer })),
  }));
  add(t.rows.length, (start) => ({
    name: 'rows',
    view: view(12, 32),
    arrive: 'lead',
    labels: [
      { at: start, text: '4 in a row', stickerAt: start + 8, sticker: 'wins.' },
      { at: start + t.rows.label, text: 'Rows', stickerAt: start + t.rows.label + t.rows.count, sticker: `+${linesOf('row').length}` },
    ],
    counter: true,
    events: [
      { kind: 'line', at: start, gap: 2, line: [60, 61, 62, 63] },
      { kind: 'jingle', at: start + 8 },
      { kind: 'set', at: start + t.rows.label + t.rows.count, of: 'row', lines: linesOf('row') },
    ],
  }));
  kind('columns', 'column', 'Columns', [51, 55, 59, 63], view(68, 32));
  kind('pillars', 'pillar', 'Pillars: the 3D twist', [14, 30, 46, 62], view(22, 9));
  kind('flat', 'flat-diagonal', 'Flat diagonals', [48, 53, 58, 63], view(30, 62));
  kind('rising-front', 'rising-diagonal', 'Rising diagonals', [12, 29, 46, 63], view(0, 12), linesOf('rising-diagonal').filter((line) => keeps(line, 'row')));
  kind('rising-side', 'rising-diagonal', 'Rising diagonals', [3, 23, 43, 63], view(90, 12), linesOf('rising-diagonal').filter((line) => keeps(line, 'column')));
  kind('corners-1', 'space-diagonal', 'Corner to corner', [0, 21, 42, 63], view(-45, 14), spacePair((row, column) => row === column));
  kind('corners-2', 'space-diagonal', 'Corner to corner', [3, 22, 41, 60], view(45, 14), spacePair((row, column) => row + column === 3));
  add(t.all.length, (start) => ({
    name: 'all',
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: start, text: `${LINES.length} ways`, stickerAt: start + t.all.count, sticker: 'to win.' }],
    counter: false,
    events: [{ kind: 'all', at: start }],
  }));
  add(t.strong.length, (start) => ({
    name: 'strong',
    view: view(38, 20),
    arrive: 'lead',
    labels: [{ at: start, text: 'Corners and the core', stickerAt: start + t.strong.count, sticker: `${MOST_LINES} lines each` }],
    counter: false,
    events: [
      { kind: 'through', at: start, gap: t.strong.gap, cell: 63 },
      { kind: 'through', at: start + t.strong.second, gap: t.strong.gap, cell: 42 },
    ],
  }));
  add(t.other.length, (start) => ({
    name: 'other',
    view: view(20, 26),
    arrive: 'lead',
    labels: [{ at: start, text: 'Every other cell', stickerAt: start + t.other.count, sticker: `${linesThrough(OTHER_CELL).length} lines` }],
    counter: false,
    events: [{ kind: 'through', at: start, gap: t.other.gap, cell: OTHER_CELL }],
  }));
  add(t.take.length, (start) => ({
    name: 'take',
    view: view(HOME_AZIMUTH, 22),
    arrive: 'lead',
    labels: [{ at: start, text: `The ${STRONG_CELLS.length} strong cells`, stickerAt: start + t.take.count, sticker: 'Take them.' }],
    counter: false,
    events: [
      { kind: 'strong', at: start },
      { kind: 'jingle', at: start + t.take.jingle },
    ],
  }));
  // The end card of the spot (the 'settle' camera): the tower shrinks into the top half of the square. As in the
  // spot, the suffix slides out 4 sixteenths after the wordmark. The call to action comes on the beat after the
  // suffix settles, both badges on the beat after it (App Store first), and the "soon" note one beat later
  // (lettering.ts), so every part shows for at least 1 s before the end.
  const card = sections.at(-1)?.end ?? 0;
  add(end - card, (start) => ({
    name: 'end-card',
    view: { azimuth: HOME_AZIMUTH, elevation: ELEVATION, distance: HOME_DISTANCE, zoom: 0.58, lift: 0.46 },
    arrive: 'land',
    labels: [],
    counter: false,
    events: [
      {
        kind: 'end-card',
        at: start,
        words: [
          { text: 'tick3d', at: start },
          { text: '.yarden-zamir.com', at: start + 4 },
          { text: 'Play in your browser.', at: start + 8 },
          { text: 'App Store', at: start + 12, badge: 'app-store', note: 'soon' },
          { text: 'Google Play', at: start + 12, badge: 'google-play' },
        ],
      },
      ...[0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse' as const, at: start + layer * 4, layer })),
      { kind: 'final-chord', at: start + 16 },
    ],
  }));
  return sections;
}

export type Plan = { pace: Pace; seconds: number; frames: number; end: number; sections: readonly Section[] };

// The plan of a pace. `end` is the end of the tutorial in sixteenths, so the final chord rings for a little over 1 s.
export function planOf(pace: Pace): Plan {
  const t = TIMINGS[pace];
  const end = t.seconds / SIXTEENTH;
  return { pace, seconds: t.seconds, frames: t.seconds * FPS, end, sections: sectionsOf(t, end) };
}

const isPace = (name: string): name is Pace => (PACES as readonly string[]).includes(name);
const requested = globalThis.process?.env?.['TUTORIAL_PACE'] ?? 'long';
if (!isPace(requested)) throw new Error(`TUTORIAL_PACE=${requested} is not one of ${PACES.join(', ')}`);
const PLAN = planOf(requested);
export const PACE = PLAN.pace;
export const DURATION_SECONDS = PLAN.seconds;
export const DURATION_FRAMES = PLAN.frames;
export const END = PLAN.end;
export const SECTIONS = PLAN.sections;

// The section of a frame.
export function sectionAt(frame: number, sections: readonly Section[] = SECTIONS): Section {
  const section = sections.findLast((entry) => frame >= frameOf(entry.start));
  if (section === undefined) throw new RangeError(`no section at frame ${frame}`);
  return section;
}

type EventOf<K extends TutorialEvent['kind']> = Extract<TutorialEvent, { kind: K }>;

// Every event of a kind, with its section.
export function eventsOf<K extends TutorialEvent['kind']>(kind: K, sections: readonly Section[] = SECTIONS): { event: EventOf<K>; section: Section }[] {
  return sections.flatMap((section) => section.events.filter((event): event is EventOf<K> => event.kind === kind).map((event) => ({ event, section })));
}

// The frame of the still of a section: 2 sixteenths before its end, when everything of it shows.
export const stillOf = (section: Section): number => Math.min(frameOf(section.end - 2), DURATION_FRAMES - 1);

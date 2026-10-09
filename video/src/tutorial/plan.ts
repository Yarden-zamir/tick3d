// The plan of the tutorial "How to win": its sections, what each one shows, and when, on the beat grid of
// src/grid.ts (sixteenths of the 136 BPM song). The numbers on screen come from the game code (lines.ts).
// creative/tutorial.md explains the plan.
import { LINES, type Line, linesThrough } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import type { Word } from '../lettering.ts';
import { ELEVATION, HOME_AZIMUTH, HOME_DISTANCE } from '../rig.ts';
import { type Kind, MOST_LINES, STRONG_CELLS, linesOf } from './lines.ts';

export const DURATION_SECONDS = 24;
export const DURATION_FRAMES = DURATION_SECONDS * FPS;
// The end of the tutorial in sixteenths: 217.6, so the final chord rings for a little over 1 s.
export const END = DURATION_SECONDS / SIXTEENTH;

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
  // Every line of a kind flashes, then stays faint. The counter adds them. Sound: a soft chord.
  | { kind: 'set'; at: number; lines: Kind }
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
const plus = (kind: Kind) => `+${linesOf(kind).length}`;

// A section for one kind of line: the label at the downbeat, an example line from the downbeat, one cell per
// sixteenth, and every line of the kind on beat 3 with its count.
function kindSection(lines: Kind, start: number, text: string, line: Line, where: View): Section {
  return {
    name: lines,
    start,
    end: start + 16,
    view: where,
    arrive: 'lead',
    labels: [{ at: start, text, stickerAt: start + 8, sticker: plus(lines) }],
    counter: true,
    events: [
      { kind: 'line', at: start, gap: 1, line },
      { kind: 'set', at: start + 8, lines },
    ],
  };
}

// A cell on 4 lines, on the front edge of the top layer.
const OTHER_CELL = 61;

export const SECTIONS: readonly Section[] = [
  {
    name: 'title',
    start: 0,
    end: 16,
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: 0, text: 'How to', stickerAt: 4, sticker: 'win' }],
    counter: false,
    events: [0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse', at: layer * 4, layer })),
  },
  {
    name: 'rows',
    start: 16,
    end: 48,
    view: view(12, 32),
    arrive: 'lead',
    labels: [
      { at: 16, text: '4 in a row', stickerAt: 24, sticker: 'wins.' },
      { at: 32, text: 'Rows', stickerAt: 32, sticker: plus('row') },
    ],
    counter: true,
    events: [
      { kind: 'line', at: 16, gap: 2, line: [60, 61, 62, 63] },
      { kind: 'jingle', at: 24 },
      { kind: 'set', at: 32, lines: 'row' },
    ],
  },
  kindSection('column', 48, 'Columns', [51, 55, 59, 63], view(68, 32)),
  kindSection('pillar', 64, 'Pillars: the 3D twist', [14, 30, 46, 62], view(22, 9)),
  kindSection('layer-diagonal', 80, 'Diagonals in a layer', [48, 53, 58, 63], view(30, 62)),
  kindSection('climbing-diagonal', 96, 'Diagonals that climb', [12, 29, 46, 63], view(0, 12)),
  kindSection('space-diagonal', 112, 'Corner to corner', [0, 21, 42, 63], view(-45, 14)),
  {
    name: 'all',
    start: 128,
    end: 144,
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: 128, text: `${LINES.length} ways`, stickerAt: 130, sticker: 'to win.' }],
    counter: false,
    events: [{ kind: 'all', at: 128 }],
  },
  {
    name: 'strong',
    start: 144,
    end: 160,
    view: view(38, 20),
    arrive: 'lead',
    labels: [{ at: 144, text: 'Corners and the core', stickerAt: 146, sticker: `${MOST_LINES} lines each` }],
    counter: false,
    events: [
      { kind: 'through', at: 144, gap: 1, cell: 63 },
      { kind: 'through', at: 152, gap: 1, cell: 42 },
    ],
  },
  {
    name: 'other',
    start: 160,
    end: 176,
    view: view(20, 26),
    arrive: 'lead',
    labels: [{ at: 160, text: 'Every other cell', stickerAt: 162, sticker: `${linesThrough(OTHER_CELL).length} lines` }],
    counter: false,
    events: [{ kind: 'through', at: 160, gap: 2, cell: OTHER_CELL }],
  },
  {
    name: 'take',
    start: 176,
    end: 192,
    view: view(HOME_AZIMUTH, 22),
    arrive: 'lead',
    labels: [{ at: 176, text: `The ${STRONG_CELLS.length} strong cells`, stickerAt: 184, sticker: 'Take them.' }],
    counter: false,
    events: [
      { kind: 'strong', at: 176 },
      { kind: 'jingle', at: 184 },
    ],
  },
  {
    name: 'end-card',
    start: 192,
    end: END,
    // The end card of the spot (the 'settle' camera): the tower shrinks into the top half of the square.
    view: { azimuth: HOME_AZIMUTH, elevation: ELEVATION, distance: HOME_DISTANCE, zoom: 0.58, lift: 0.46 },
    arrive: 'land',
    labels: [],
    counter: false,
    events: [
      // As in the spot: the suffix slides out 4 sixteenths after the wordmark. The call to action comes on the
      // beat after the suffix settles, and the badges one beat apart, so "iOS" still shows for 1 s at the end.
      {
        kind: 'end-card',
        at: 192,
        words: [
          { text: 'tick3d', at: 192 },
          { text: '.yarden-zamir.com', at: 196 },
          { text: 'Play in your browser.', at: 200 },
          { text: 'Android', at: 204, icon: 'play-store' },
          { text: 'iOS', at: 208, icon: 'apple' },
        ],
      },
      ...[0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse' as const, at: 192 + layer * 4, layer })),
      { kind: 'final-chord', at: 208 },
    ],
  },
];

// The section of a frame.
export function sectionAt(frame: number): Section {
  const section = SECTIONS.findLast((entry) => frame >= frameOf(entry.start));
  if (section === undefined) throw new RangeError(`no section at frame ${frame}`);
  return section;
}

type EventOf<K extends TutorialEvent['kind']> = Extract<TutorialEvent, { kind: K }>;

// Every event of a kind, with its section.
export function eventsOf<K extends TutorialEvent['kind']>(kind: K): { event: EventOf<K>; section: Section }[] {
  return SECTIONS.flatMap((section) => section.events.filter((event): event is EventOf<K> => event.kind === kind).map((event) => ({ event, section })));
}

// The frame of the still of a section: 2 sixteenths before its end, when everything of it shows.
export const stillOf = (section: Section): number => Math.min(frameOf(section.end - 2), DURATION_FRAMES - 1);

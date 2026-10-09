// The plan of the tutorial "How to win": its sections, what each one shows, and when, on the beat grid of
// src/grid.ts (sixteenths of the 136 BPM song). The numbers on screen come from the game code (lines.ts).
// creative/tutorial.md explains the plan.
import { LINES, type Line, linesThrough, toCoords } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import type { Word } from '../lettering.ts';
import { ELEVATION, HOME_AZIMUTH, HOME_DISTANCE } from '../rig.ts';
import { type Kind, MOST_LINES, STRONG_CELLS, keeps, linesOf } from './lines.ts';

export const DURATION_SECONDS = 27.5;
export const DURATION_FRAMES = DURATION_SECONDS * FPS;
// The end of the tutorial in sixteenths: 249.3, so the final chord rings for a little over 1 s.
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

// A bar for a kind of line: the label at the downbeat, an example line from the downbeat, one cell per sixteenth,
// and on beat 3 the lines of the kind that this bar shows (all of them by default) with their count.
function kindSection(name: string, of: Kind, start: number, text: string, line: Line, where: View, lines = linesOf(of)): Section {
  return {
    name,
    start,
    end: start + 16,
    view: where,
    arrive: 'lead',
    labels: [{ at: start, text, stickerAt: start + 8, sticker: `+${lines.length}` }],
    counter: true,
    events: [
      { kind: 'line', at: start, gap: 1, line },
      { kind: 'set', at: start + 8, of, lines },
    ],
  };
}

// The space diagonals in pairs that cross in one vertical plane through the cube: the plane of corners 0 and 63
// (row = column), and the plane of corners 3 and 60 (row + column = 3). Each pair reads as an X from square on.
const spacePair = (onPlane: (row: number, column: number) => boolean) =>
  linesOf('space-diagonal').filter((line) => line.every((cell) => onPlane(toCoords(cell).row, toCoords(cell).column)));

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
      { at: 32, text: 'Rows', stickerAt: 32, sticker: `+${linesOf('row').length}` },
    ],
    counter: true,
    events: [
      { kind: 'line', at: 16, gap: 2, line: [60, 61, 62, 63] },
      { kind: 'jingle', at: 24 },
      { kind: 'set', at: 32, of: 'row', lines: linesOf('row') },
    ],
  },
  kindSection('columns', 'column', 48, 'Columns', [51, 55, 59, 63], view(68, 32)),
  kindSection('pillars', 'pillar', 64, 'Pillars: the 3D twist', [14, 30, 46, 62], view(22, 9)),
  kindSection('flat', 'flat-diagonal', 80, 'Flat diagonals', [48, 53, 58, 63], view(30, 62)),
  // The rising diagonals take 2 bars: the 8 on the planes that face the front, then the 8 on the side planes,
  // each seen square on.
  kindSection('rising-front', 'rising-diagonal', 96, 'Rising diagonals', [12, 29, 46, 63], view(0, 12), linesOf('rising-diagonal').filter((line) => keeps(line, 'row'))),
  kindSection('rising-side', 'rising-diagonal', 112, 'Rising diagonals', [3, 23, 43, 63], view(90, 12), linesOf('rising-diagonal').filter((line) => keeps(line, 'column'))),
  // The space diagonals take 2 bars: one crossing pair each.
  kindSection('corners-1', 'space-diagonal', 128, 'Corner to corner', [0, 21, 42, 63], view(-45, 14), spacePair((row, column) => row === column)),
  kindSection('corners-2', 'space-diagonal', 144, 'Corner to corner', [3, 22, 41, 60], view(45, 14), spacePair((row, column) => row + column === 3)),
  {
    name: 'all',
    start: 160,
    end: 176,
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: 160, text: `${LINES.length} ways`, stickerAt: 162, sticker: 'to win.' }],
    counter: false,
    events: [{ kind: 'all', at: 160 }],
  },
  {
    name: 'strong',
    start: 176,
    end: 192,
    view: view(38, 20),
    arrive: 'lead',
    labels: [{ at: 176, text: 'Corners and the core', stickerAt: 178, sticker: `${MOST_LINES} lines each` }],
    counter: false,
    events: [
      { kind: 'through', at: 176, gap: 1, cell: 63 },
      { kind: 'through', at: 184, gap: 1, cell: 42 },
    ],
  },
  {
    name: 'other',
    start: 192,
    end: 208,
    view: view(20, 26),
    arrive: 'lead',
    labels: [{ at: 192, text: 'Every other cell', stickerAt: 194, sticker: `${linesThrough(OTHER_CELL).length} lines` }],
    counter: false,
    events: [{ kind: 'through', at: 192, gap: 2, cell: OTHER_CELL }],
  },
  {
    name: 'take',
    start: 208,
    end: 224,
    view: view(HOME_AZIMUTH, 22),
    arrive: 'lead',
    labels: [{ at: 208, text: `The ${STRONG_CELLS.length} strong cells`, stickerAt: 216, sticker: 'Take them.' }],
    counter: false,
    events: [
      { kind: 'strong', at: 208 },
      { kind: 'jingle', at: 216 },
    ],
  },
  {
    name: 'end-card',
    start: 224,
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
        at: 224,
        words: [
          { text: 'tick3d', at: 224 },
          { text: '.yarden-zamir.com', at: 228 },
          { text: 'Play in your browser.', at: 232 },
          { text: 'Android', at: 236, icon: 'play-store' },
          { text: 'iOS', at: 240, icon: 'apple' },
        ],
      },
      ...[0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse' as const, at: 224 + layer * 4, layer })),
      { kind: 'final-chord', at: 240 },
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

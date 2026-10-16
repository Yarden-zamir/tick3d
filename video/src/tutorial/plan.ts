// The plans of the tutorials: their sections, what each one shows, and when, on the beat grid of src/grid.ts
// (sixteenths of the 136 BPM song). The numbers on screen come from the game code (lines.ts). There are two
// tutorials: 'basics' ("How to play", the one the game shows in its Info panel) and 'strong' (the strong cells).
// Each comes at two paces: 'long' (slow enough to read every label) and 'short'. TUTORIAL and TUTORIAL_PACE pick
// one; scripts/tutorial.ts passes them into the render browser. creative/tutorial.md explains the plans.
// Some sections start a checkpoint (`chapter`): the Info panel of the game jumps between them (chaptersOf).
import { LINES, type Line, linesThrough, toCoords } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import type { Word } from '../lettering.ts';
import { ELEVATION, HOME_AZIMUTH, HOME_DISTANCE, ease } from '../rig.ts';
import { KINDS, type Kind, MOST_LINES, STRONG_CELLS, keeps, linesOf } from './lines.ts';

export const TUTORIALS = ['basics', 'strong'] as const;
export type TutorialId = (typeof TUTORIALS)[number];
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
  | { kind: 'final-chord'; at: number }
  // A finger mark comes in, presses `cell` at `at` with a ripple, and lifts. An X lands on the cell on the press.
  // Sound: a soft note on the press.
  | { kind: 'tap'; at: number; cell: number }
  // A finger mark presses under the tower and drags to the left for `length` sixteenths. The camera turns `turn`
  // degrees with it, so the tower follows the finger. Sound: a soft note per beat of the drag.
  | { kind: 'drag'; at: number; length: number; turn: number }
  // An O lands on each of the first 3 cells of `line`, one every `gap` sixteenths. An O beam then reaches for the
  // fourth cell, and at `blocked` (the tap of the X on the fourth cell) it stops short and goes dim. Sound: a soft
  // note per O, a minor chord on the threat, a major chord on the block.
  | { kind: 'block'; at: number; gap: number; line: Line; blocked: number }
  // X and O take turns: a mark lands on each cell of `cells`, X first, one every `gap` sixteenths (a gap can be a
  // part of a sixteenth). With `frame`, a frame around the picture shows the color of the player to move. Sound: a
  // soft note per mark on a whole sixteenth.
  | { kind: 'turns'; at: number; gap: number; cells: readonly number[]; frame: boolean }
  // An X sits on `cell` from the start of the section. A finger mark taps it at `at`, and UNDO_LIFT later, when
  // the finger has moved off it, the X lifts away. Sound: a falling note on the tap.
  | { kind: 'undo'; at: number; cell: number }
  // A soft chord.
  | { kind: 'chord'; at: number };

// The label above the tower: a plain line, and a sticker under it that slams in at `stickerAt`. It shows until
// the next label of its section, or the end of the section.
type Label = { at: number; text: string; stickerAt: number; sticker: string };

// A checkpoint of the video in the Info panel of the game: a headline, one or two short sentences, and `frame`,
// the sixteenth where the picture of the checkpoint is complete: its label and sticker show, and its example or
// set has drawn. The panel shows this frame when the slider lands on the checkpoint.
type Chapter = { headline: string; text: string; frame: number };

export type Section = {
  name: string;
  // The section starts a checkpoint. The sections without one belong to the checkpoint before them.
  chapter?: Chapter;
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

// The drift of the camera in degrees per sixteenth (camera.ts): a quarter turn takes about 30 s, so the tower
// never stands still.
export const DRIFT_PER_S16 = 0.35;

const view = (azimuth: number, elevation: number, distance = HOME_DISTANCE, zoom = 0.86, lift = -0.08): View => ({ azimuth, elevation, distance, zoom, lift });

// The space diagonals in pairs that cross in one vertical plane through the cube: the plane of corners 0 and 63
// (row = column), and the plane of corners 3 and 60 (row + column = 3). Each pair reads as an X from square on.
const spacePair = (onPlane: (row: number, column: number) => boolean) =>
  linesOf('space-diagonal').filter((line) => line.every((cell) => onPlane(toCoords(cell).row, toCoords(cell).column)));

// A cell on 4 lines, on the front edge of the top layer.
const OTHER_CELL = 61;
// The cell of the first tap: on the top layer, near the front, so the X shows from above.
const TAP_CELL = 53;
// The line of "Block it": 3 O on the right edge of the top layer, and the X on corner 63.
const BLOCK_LINE: Line = [51, 55, 59, 63];
// The turn of "Drag": a quarter turn. It ends near the view of the rows.
const DRAG_TURN = 90;
// The sixteenths from the tap of an undo to the lift of its X: the finger moves off first, so the ripple shows
// around the X that it takes back.
export const UNDO_LIFT = 2;
// "Four" in the texts: the cells of a line.
const FOUR = 'Four';
// "Take turns": 3 marks each on the top layer, X first. No 3 of one player share a line.
const TURN_CELLS = [53, 54, 58, 57, 49, 62] as const;
// A full cube with no line of 4 for X or O: 32 X and 32 O, by cell. A seeded random search with swaps found it
// (plan.test.ts proves it with LINES).
export const DRAW_BOARD = 'XOXXOXOXXXXOXXXOOXOOOXOOOOOXXOXXXXXOXXOXOXOOOOOXOXOOXOXXXOXOOOOX';
// The order of the draw: X and O in turns, each from the bottom layer up.
const drawOrder = (): number[] => {
  const of = (player: string) => [...DRAW_BOARD].flatMap((mark, cell) => (mark === player ? [cell] : []));
  const xs = of('X');
  const os = of('O');
  return xs.flatMap((cell, i) => [cell, os[i] ?? -1]).filter((cell) => cell >= 0);
};

// The timing of a pace, in sixteenths. Each section starts where the one before it ends; its events and labels
// count from its start. A count (the sticker of a label) comes `count` after its label.
type Timing = {
  // A kind of line: the section length, one example cell per `cellGap`, and the set of lines at `set`.
  kind: { length: number; cellGap: number; count: number; set: number };
  // "4 in a row / wins.", then "Rows" at `label` with its set.
  rows: { length: number; label: number; count: number };
  all: { length: number; count: number };
  // Corner 63 and its 7 lines, one per `gap`, then core cell 42 at `second`.
  strong: { length: number; gap: number; second: number; count: number };
  other: { length: number; gap: number; count: number };
  take: { length: number; count: number; jingle: number };
  // "Tap a cell", the press at `tap`. "Drag", the drag from `drag` for `turn` sixteenths.
  tap: { length: number; count: number; tap: number };
  drag: { length: number; count: number; drag: number; turn: number };
  // "Three in a line?": an O every `gap`, the threat 1 gap after the third O, the tap of the X at `tap`.
  block: { length: number; gap: number; count: number; tap: number };
  // "Take turns": a mark every `gap` from `first`. "Changed your mind?": the tap at `tap`.
  turns: { length: number; count: number; first: number; gap: number };
  undo: { length: number; count: number; tap: number };
  // "Full cube, no line?": a mark every `gap`, so the cube fills in 16 sixteenths. The sticker 2 after the last.
  draw: { length: number; gap: number };
};

const TIMINGS: Readonly<Record<Pace, Timing>> = {
  // Slow enough to read every label and to follow every example (maintainer feedback on #119).
  long: {
    kind: { length: 24, cellGap: 2, count: 6, set: 12 },
    rows: { length: 40, label: 20, count: 4 },
    all: { length: 24, count: 6 },
    strong: { length: 40, gap: 2, second: 20, count: 6 },
    other: { length: 24, gap: 4, count: 6 },
    take: { length: 24, count: 10, jingle: 12 },
    tap: { length: 24, count: 4, tap: 8 },
    drag: { length: 24, count: 6, drag: 4, turn: 12 },
    block: { length: 24, gap: 2, count: 8, tap: 12 },
    turns: { length: 32, count: 4, first: 6, gap: 4 },
    undo: { length: 24, count: 4, tap: 8 },
    draw: { length: 32, gap: 0.25 },
  },
  // One bar for each kind of line.
  short: {
    kind: { length: 16, cellGap: 1, count: 8, set: 8 },
    rows: { length: 32, label: 16, count: 0 },
    all: { length: 16, count: 2 },
    strong: { length: 16, gap: 1, second: 8, count: 2 },
    other: { length: 16, gap: 2, count: 2 },
    take: { length: 16, count: 8, jingle: 8 },
    tap: { length: 16, count: 2, tap: 4 },
    drag: { length: 16, count: 4, drag: 2, turn: 10 },
    block: { length: 16, gap: 1, count: 5, tap: 8 },
    turns: { length: 16, count: 2, first: 2, gap: 2 },
    undo: { length: 16, count: 2, tap: 4 },
    draw: { length: 24, gap: 0.25 },
  },
};

// The end card lasts at least this long, so the "soon" note shows for 1 s; the tutorial ends on a whole second.
const CARD_SECONDS = 2.8;

// The title of each tutorial: the label and its checkpoint.
const TITLES: Readonly<Record<TutorialId, { label: Pick<Label, 'text' | 'sticker'>; chapter: Omit<Chapter, 'frame'> }>> = {
  basics: { label: { text: 'How to', sticker: 'play' }, chapter: { headline: 'How to play', text: `Get ${FOUR.toLowerCase()} of your marks in a straight line to win.` } },
  strong: { label: { text: 'Strong', sticker: 'cells' }, chapter: { headline: 'Where to play', text: 'Some cells sit on more lines than others. Take those first.' } },
};

// The sections of a tutorial at a pace, back to back from 0, and its end in sixteenths. The rising and the space
// diagonals are the hard kinds, so each gets 2 sections, each with its own example and half of the set, seen
// square on.
function sectionsOf(t: Timing, tutorial: TutorialId): { sections: Section[]; end: number } {
  const sections: Section[] = [];
  const add = (length: number, make: (start: number) => Omit<Section, 'start' | 'end'>) => {
    const start = sections.at(-1)?.end ?? 0;
    sections.push({ ...make(start), start, end: start + length });
  };
  // A kind of line with a checkpoint pictures it once its set has flashed and settled to faint.
  const kind = (name: string, of: Kind, text: string, line: Line, where: View, chapter: Omit<Chapter, 'frame'> | undefined, lines = linesOf(of)) =>
    add(t.kind.length, (start) => ({
      name,
      ...(chapter === undefined ? {} : { chapter: { ...chapter, frame: start + t.kind.set + 6 } }),
      view: where,
      arrive: 'lead',
      labels: [{ at: start, text, stickerAt: start + t.kind.count, sticker: `+${lines.length}` }],
      counter: true,
      events: [
        { kind: 'line', at: start, gap: t.kind.cellGap, line },
        { kind: 'set', at: start + t.kind.set, of, lines },
      ],
    }));

  const title = () => add(16, () => ({
    name: 'title',
    chapter: { ...TITLES[tutorial].chapter, frame: 8 },
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: 0, ...TITLES[tutorial].label, stickerAt: 4 }],
    counter: false,
    events: [0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse', at: layer * 4, layer })),
  }));
  // The frame takes the color of the player to move, from X before the first mark.
  const turns = () => add(t.turns.length, (start) => ({
    name: 'turns',
    chapter: { headline: 'Take turns', text: 'X goes first, then O. The frame around the board shows whose turn it is.', frame: start + t.turns.first + t.turns.gap * (TURN_CELLS.length - 1) + 2 },
    view: view(-30, 44),
    arrive: 'lead',
    labels: [{ at: start, text: 'Take turns', stickerAt: start + t.turns.count, sticker: 'X goes first.' }],
    counter: false,
    events: [{ kind: 'turns', at: start + t.turns.first, gap: t.turns.gap, cells: TURN_CELLS, frame: true }],
  }));
  const tap = () => add(t.tap.length, (start) => ({
    name: 'tap',
    chapter: { headline: 'Place a mark', text: 'Tap an empty cell to put your mark there.', frame: start + t.tap.tap + 2 },
    view: view(-60, 44),
    arrive: 'lead',
    labels: [{ at: start, text: 'Tap a cell', stickerAt: start + t.tap.count, sticker: 'to place.' }],
    counter: false,
    events: [{ kind: 'tap', at: start + t.tap.tap, cell: TAP_CELL }],
  }));
  // The same cell as the tap, and the view where the tap ends, so the X of the tap stays in place.
  const undo = () => add(t.undo.length, (start) => ({
    name: 'undo',
    chapter: { headline: 'Take it back', text: 'Tap your last mark again to take it back. A game against the computer has no undo.', frame: start + t.undo.tap + UNDO_LIFT },
    view: view(-60 + DRIFT_PER_S16 * t.tap.length, 44),
    arrive: 'lead',
    labels: [{ at: start, text: 'Changed your mind?', stickerAt: start + t.undo.count, sticker: 'Tap it again.' }],
    counter: false,
    events: [{ kind: 'undo', at: start + t.undo.tap, cell: TAP_CELL }],
  }));
  // The camera turns with the drag, then drifts on: the section ends near the view of the rows.
  const drag = () => add(t.drag.length, (start) => ({
    name: 'drag',
    chapter: { headline: 'Turn the tower', text: 'Drag around the tower to turn it. View, under More, shows a flat board.', frame: start + t.drag.drag + t.drag.turn / 2 },
    view: view(-80, 26),
    arrive: 'lead',
    labels: [{ at: start, text: 'Drag', stickerAt: start + t.drag.count, sticker: 'to turn it.' }],
    counter: false,
    events: [{ kind: 'drag', at: start + t.drag.drag, length: t.drag.turn, turn: DRAG_TURN }],
  }));
  const rows = () => add(t.rows.length, (start) => ({
    name: 'rows',
    chapter: { headline: 'Rows', text: `${FOUR} across a layer wins: ${linesOf('row').length} rows.`, frame: start + t.rows.label + t.rows.count + 6 },
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
  const kinds = () => {
    kind('columns', 'column', 'Columns', [51, 55, 59, 63], view(68, 32), { headline: 'Columns', text: `${FOUR} front to back in a layer: ${linesOf('column').length} more.` });
    kind('pillars', 'pillar', 'Pillars: the 3D twist', [14, 30, 46, 62], view(22, 9), { headline: 'Pillars', text: `${FOUR} straight up through the layers: the 3D twist.` });
    kind('flat', 'flat-diagonal', 'Flat diagonals', [48, 53, 58, 63], view(30, 62), { headline: 'Flat diagonals', text: `Corner to corner inside one layer: ${linesOf('flat-diagonal').length} lines.` });
    kind('rising-front', 'rising-diagonal', 'Rising diagonals', [12, 29, 46, 63], view(0, 12), { headline: 'Rising diagonals', text: `Diagonals that climb through the layers: ${linesOf('rising-diagonal').length} lines.` }, linesOf('rising-diagonal').filter((line) => keeps(line, 'row')));
    kind('rising-side', 'rising-diagonal', 'Rising diagonals', [3, 23, 43, 63], view(90, 12), undefined, linesOf('rising-diagonal').filter((line) => keeps(line, 'column')));
    kind('corners-1', 'space-diagonal', 'Corner to corner', [0, 21, 42, 63], view(-45, 14), { headline: 'Corner to corner', text: `Through the middle of the cube: ${linesOf('space-diagonal').length} lines.` }, spacePair((row, column) => row === column));
    kind('corners-2', 'space-diagonal', 'Corner to corner', [3, 22, 41, 60], view(45, 14), undefined, spacePair((row, column) => row + column === 3));
  };
  const all = () => add(t.all.length, (start) => ({
    name: 'all',
    chapter: { headline: `${LINES.length} ways to win`, text: 'Every kind of line together.', frame: start + KINDS.length + 6 },
    view: view(HOME_AZIMUTH, ELEVATION),
    arrive: 'lead',
    labels: [{ at: start, text: `${LINES.length} ways`, stickerAt: start + t.all.count, sticker: 'to win.' }],
    counter: false,
    events: [{ kind: 'all', at: start }],
  }));
  const strong = () => add(t.strong.length, (start) => ({
    name: 'strong',
    chapter: { headline: 'Strong cells', text: `Corners and the core sit on ${MOST_LINES} lines each. Every other cell sits on ${linesThrough(OTHER_CELL).length}.`, frame: start + t.strong.second - 1 },
    view: view(38, 20),
    arrive: 'lead',
    labels: [{ at: start, text: 'Corners and the core', stickerAt: start + t.strong.count, sticker: `${MOST_LINES} lines each` }],
    counter: false,
    events: [
      { kind: 'through', at: start, gap: t.strong.gap, cell: 63 },
      { kind: 'through', at: start + t.strong.second, gap: t.strong.gap, cell: 42 },
    ],
  }));
  const other = () => add(t.other.length, (start) => ({
    name: 'other',
    view: view(20, 26),
    arrive: 'lead',
    labels: [{ at: start, text: 'Every other cell', stickerAt: start + t.other.count, sticker: `${linesThrough(OTHER_CELL).length} lines` }],
    counter: false,
    events: [{ kind: 'through', at: start, gap: t.other.gap, cell: OTHER_CELL }],
  }));
  const take = () => add(t.take.length, (start) => ({
    name: 'take',
    chapter: { headline: 'Take them', text: `Grab the ${STRONG_CELLS.length} strong cells early.`, frame: start + t.take.count + 4 },
    view: view(HOME_AZIMUTH, 22),
    arrive: 'lead',
    labels: [{ at: start, text: `The ${STRONG_CELLS.length} strong cells`, stickerAt: start + t.take.count, sticker: 'Take them.' }],
    counter: false,
    events: [
      { kind: 'strong', at: start },
      { kind: 'jingle', at: start + t.take.jingle },
    ],
  }));
  const block = () => add(t.block.length, (start) => ({
    name: 'block',
    chapter: { headline: 'Block it', text: 'Three of theirs in a line? Put your mark on the fourth cell.', frame: start + t.block.tap + 4 },
    view: view(62, 36),
    arrive: 'lead',
    labels: [{ at: start, text: 'Three in a line?', stickerAt: start + t.block.count, sticker: 'Block it.' }],
    counter: false,
    events: [
      { kind: 'block', at: start, gap: t.block.gap, line: BLOCK_LINE, blocked: start + t.block.tap },
      { kind: 'tap', at: start + t.block.tap, cell: BLOCK_LINE[3] },
    ],
  }));
  // The cube fills with the marks of DRAW_BOARD, X and O in turns, and no line wins.
  const draw = () => add(t.draw.length, (start) => {
    const cells = drawOrder();
    const full = start + Math.ceil(cells.length * t.draw.gap);
    return {
      name: 'draw',
      chapter: { headline: 'A draw', text: 'A full cube with no line of four is a draw.', frame: full + 4 },
      view: view(HOME_AZIMUTH, 30),
      arrive: 'lead',
      labels: [{ at: start, text: 'Full cube, no line?', stickerAt: full + 2, sticker: 'A draw.' }],
      counter: false,
      events: [
        { kind: 'turns', at: start, gap: t.draw.gap, cells, frame: false },
        { kind: 'chord', at: full + 2 },
      ],
    };
  });
  const builds: Readonly<Record<TutorialId, readonly (() => void)[]>> = {
    basics: [title, turns, tap, undo, drag, rows, kinds, all, block, draw],
    strong: [title, all, strong, other, take],
  };
  for (const build of builds[tutorial]) build();
  // The end card of the spot (the 'settle' camera): the tower shrinks into the top half of the square. As in the
  // spot, the suffix slides out 4 sixteenths after the wordmark. The call to action comes on the beat after the
  // suffix settles, both badges on the beat after it (App Store first), and the "soon" note one beat later
  // (lettering.ts), so every part shows for at least 1 s before the end.
  const card = sections.at(-1)?.end ?? 0;
  const end = Math.ceil(card * SIXTEENTH + CARD_SECONDS) / SIXTEENTH;
  add(end - card, (start) => ({
    name: 'end-card',
    chapter: { headline: 'More to find', text: 'Hover or long-press an icon to see what it does. The speaker arrow opens sound sets. More holds the view and play by voice.', frame: start + 17 },
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
  return { sections, end };
}

export type Plan = { tutorial: TutorialId; pace: Pace; name: string; seconds: number; frames: number; end: number; sections: readonly Section[] };

// The plan of a tutorial at a pace. `end` is the end in sixteenths, on a whole second, so the final chord rings for
// a little over 1 s. `name` names its files: "tutorial-basics", "tutorial-basics-short", and so on.
export function planOf(tutorial: TutorialId, pace: Pace): Plan {
  const { sections, end } = sectionsOf(TIMINGS[pace], tutorial);
  const seconds = Math.round(end * SIXTEENTH);
  const name = pace === 'long' ? `tutorial-${tutorial}` : `tutorial-${tutorial}-${pace}`;
  return { tutorial, pace, name, seconds, frames: seconds * FPS, end, sections };
}

const oneOf = <T extends string>(variable: string, fallback: T, values: readonly T[]): T => {
  const value = globalThis.process?.env?.[variable] ?? fallback;
  const found = values.find((entry) => entry === value);
  if (found === undefined) throw new Error(`${variable}=${value} is not one of ${values.join(', ')}`);
  return found;
};
const PLAN = planOf(oneOf('TUTORIAL', 'basics', TUTORIALS), oneOf('TUTORIAL_PACE', 'long', PACES));
export const TUTORIAL = PLAN.tutorial;
export const NAME = PLAN.name;
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

export type EventOf<K extends TutorialEvent['kind']> = Extract<TutorialEvent, { kind: K }>;

// Every event of a kind, with its section.
export function eventsOf<K extends TutorialEvent['kind']>(kind: K, sections: readonly Section[] = SECTIONS): { event: EventOf<K>; section: Section }[] {
  return sections.flatMap((section) => section.events.filter((event): event is EventOf<K> => event.kind === kind).map((event) => ({ event, section })));
}

// The checkpoints of a pace for the Info panel of the game, in order: the start of each section with a chapter and
// the frame of its chapter, in seconds, rounded to the millisecond.
type Checkpoint = { start: number; frame: number; headline: string; text: string };
const secondsOf = (s16: number) => Math.round(s16 * SIXTEENTH * 1000) / 1000;
export const chaptersOf = (tutorial: TutorialId, pace: Pace): Checkpoint[] =>
  planOf(tutorial, pace).sections.flatMap(({ start, chapter }) =>
    chapter === undefined ? [] : [{ start: secondsOf(start), frame: secondsOf(chapter.frame), headline: chapter.headline, text: chapter.text }],
  );

// How far a drag has come at `s16`, from 0 to 1. The camera and the finger mark both follow it.
export const dragShare = (drag: EventOf<'drag'>, s16: number): number => ease((s16 - drag.at) / drag.length, 0, 1);

// The frame of the still of a section: 2 sixteenths before its end, when everything of it shows.
export const stillOf = (section: Section): number => Math.min(frameOf(section.end - 2), DURATION_FRAMES - 1);

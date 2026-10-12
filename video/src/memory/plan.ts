// The plans of the smart-memory ad (issue #130): what shows and when, on the beat grid of src/grid.ts (sixteenths
// of the 136 BPM song, 16 to a bar). Each plan is a 'full' cut (at most 15.0 s) or a 'short' cut (at most 8.0 s).
// MEMORY_PLAN picks one; scripts/memory.ts passes it into the render browser. 'full' and 'short' are variant A
// "Shatter" of the storyboards on #130. 'remember' (variant B), 'numbers' (variant C) and 'next-level' (A with the
// Hide coordinates proposal) are mock-ups for the maintainers' pick. After the pick, the chosen variant becomes
// 'full' and 'short', and the other plans go.
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import { ELEVATION, HOME_AZIMUTH } from '../rig.ts';
import { playerOf } from './game.ts';

type Cut = 'full' | 'short';
export const PLAN_IDS = ['full', 'short', 'remember', 'numbers', 'next-level'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

// Where the camera stands: a point on an orbit around the centre of the tower (see tutorial/plan.ts).
export type View = { azimuth: number; elevation: number; zoom: number; lift: number };

export type MemoryEvent =
  // The tower and its marks blow apart and fade. A faint wireframe of the 64 cells stays: Hide board.
  | { kind: 'shatter'; at: number }
  // The coordinate keypad slides in under the wireframe, and out again at `until`.
  | { kind: 'keypad'; at: number; until: number }
  // A move of the game. An O move shows its digits in the slots at `at`. An X move types its digits on the
  // sixteenths before `at`, one per `gap`, and places on `at`. Either way a ghost mark flashes at the cell, then
  // fades to a faint trail. An older trail fades out when a newer one comes: Hide history.
  | { kind: 'move'; at: number; move: number; gap: number }
  // The slots spin to `? ? ?` and show the last move so from then on: Hide coordinates. With `toggle`, the Hide
  // buttons of the game panel show above the slots from the keypad on, Board and History on, and the Coordinates
  // button switches on at `at` (the "next level" proposal on #130).
  | { kind: 'mask'; at: number; toggle?: true }
  // The marks of the board at the shatter fade back as ghosts, one per sixteenth, in the order of the moves.
  | { kind: 'recall'; at: number }
  // Every winning line of the game flashes, thin, then fades over 8 sixteenths.
  | { kind: 'all-lines'; at: number }
  // The trails of the X marks light, and the two lines of the double threat draw through them.
  | { kind: 'threats'; at: number }
  // The whole board snaps back with every mark, and the winning line burns across the cube.
  | { kind: 'reveal'; at: number }
  // The wordmark and the address (lettering.ts endCard), the tower shrinks into the top half.
  | { kind: 'end-card'; at: number }
  | { kind: 'final-chord'; at: number };

// A line of text in the top band of the square. It wraps into rows when it does not fit the width.
type TextLine = { at: number; until: number; text: string };

export type Plan = {
  id: PlanId;
  cut: Cut;
  seconds: number;
  // The board at the first frame: the moves before this one are on it.
  firstMove: number;
  events: readonly MemoryEvent[];
  text: readonly TextLine[];
  // Camera keys: the camera eases from one key to the next.
  camera: readonly { at: number; view: View }[];
  // The stills for the review: a name and a sixteenth each. 'threat' is the cover image of a format.
  stills: readonly { name: string; at: number }[];
};

const view = (azimuth: number, elevation = ELEVATION, zoom = 0.82, lift = 0.1): View => ({ azimuth, elevation, zoom, lift });
// While the keypad shows, the tower sits small in the top part of the square, above the keypad.
const OVER_KEYPAD = { zoom: 0.7, lift: 0.34 } as const;
const keypadView = (azimuth: number, elevation = ELEVATION, zoom: number = OVER_KEYPAD.zoom): View => view(azimuth, elevation, zoom, OVER_KEYPAD.lift);
// The end card: the tower small in the middle, the line above it and the address under it.
const END_VIEW: View = { azimuth: HOME_AZIMUTH + 40, elevation: ELEVATION, zoom: 0.5, lift: 0.08 };

// The moves from `from` on, at the given sixteenths. An X move types over the 3 sixteenths before its place.
const moves = (from: number, ats: readonly number[]): MemoryEvent[] => ats.map((at, i) => ({ kind: 'move', at, move: from + i, gap: 1 }));

const PLANS: Readonly<Record<PlanId, Omit<Plan, 'id'>>> = {
  // 7 bars and the final chord: 13.0 s.
  full: {
    cut: 'full',
    seconds: 13,
    firstMove: 5,
    events: [
      { kind: 'shatter', at: 4 },
      { kind: 'keypad', at: 16, until: 80 },
      // Bars 2 and 3: the memory load. O 3 3 2, X 1 4 4, O 1 4 1, X 2 3 3, O 3 2 2.
      ...moves(5, [20, 28, 32, 38, 42]),
      { kind: 'mask', at: 44 },
      // Bars 4 and 5: the double threat, X 2 4 3, O blocks at 2 1 3, X wins on 3 4 2.
      { kind: 'threats', at: 48 },
      ...moves(10, [60, 64, 72]),
      { kind: 'reveal', at: 80 },
      { kind: 'end-card', at: 96 },
      { kind: 'final-chord', at: 112 },
    ],
    text: [
      { at: 2, until: 18, text: "Win a game you can't see?" },
      { at: 82, until: 96, text: 'That was all memory.' },
      { at: 104, until: Infinity, text: 'Top 1%? Prove it.' },
    ],
    camera: [
      { at: 0, view: view(HOME_AZIMUTH) },
      { at: 12, view: view(HOME_AZIMUTH + 6) },
      { at: 17, view: keypadView(HOME_AZIMUTH + 10) },
      { at: 48, view: keypadView(HOME_AZIMUTH + 22) },
      { at: 60, view: keypadView(HOME_AZIMUTH + 30, ELEVATION + 4, 0.78) },
      { at: 78, view: keypadView(HOME_AZIMUTH + 34, ELEVATION + 4, 0.78) },
      { at: 84, view: view(HOME_AZIMUTH + 38, ELEVATION, 0.86, 0) },
      { at: 96, view: view(HOME_AZIMUTH + 40, ELEVATION, 0.86, 0) },
      { at: 100, view: END_VIEW },
    ],
    stills: [
      { name: 'hook', at: 6 },
      { name: 'memory', at: 46 },
      { name: 'threat', at: 62 },
      { name: 'reveal', at: 86 },
      { name: 'end-card', at: 117 },
    ],
  },
  // 4 bars and the final chord: 7.6 s. The board shatters, the keypad shows `? ? ?`, X types the win, the board
  // snaps back, the end card.
  short: {
    cut: 'short',
    seconds: 7.6,
    firstMove: 12,
    events: [
      { kind: 'shatter', at: 4 },
      { kind: 'keypad', at: 14, until: 32 },
      { kind: 'mask', at: 16 },
      { kind: 'threats', at: 18 },
      ...moves(12, [28]),
      { kind: 'reveal', at: 32 },
      { kind: 'end-card', at: 48 },
      { kind: 'final-chord', at: 64 },
    ],
    text: [
      { at: 2, until: 16, text: "Win a game you can't see?" },
      { at: 54, until: Infinity, text: 'Top 1%? Prove it.' },
    ],
    camera: [
      { at: 0, view: view(HOME_AZIMUTH) },
      { at: 10, view: view(HOME_AZIMUTH + 5) },
      { at: 15, view: keypadView(HOME_AZIMUTH + 8) },
      { at: 30, view: keypadView(HOME_AZIMUTH + 14, ELEVATION + 4, 0.78) },
      { at: 36, view: view(HOME_AZIMUTH + 18, ELEVATION, 0.86, 0) },
      { at: 48, view: view(HOME_AZIMUTH + 22, ELEVATION, 0.86, 0) },
      { at: 52, view: END_VIEW },
    ],
    stills: [
      { name: 'hook', at: 6 },
      { name: 'memory', at: 18 },
      { name: 'threat', at: 30 },
      { name: 'reveal', at: 38 },
      { name: 'end-card', at: 68 },
    ],
  },
  // Variant B "Remember this": 6 bars and the final chord, 11.5 s. The full board at the fork, X to move, then
  // it dissolves, and the viewer tries to recall it.
  remember: {
    cut: 'full',
    seconds: 11.5,
    firstMove: 10,
    events: [
      { kind: 'shatter', at: 8 },
      { kind: 'keypad', at: 16, until: 64 },
      { kind: 'mask', at: 18 },
      { kind: 'recall', at: 32 },
      { kind: 'threats', at: 40 },
      ...moves(10, [52, 56, 60]),
      { kind: 'reveal', at: 64 },
      { kind: 'end-card', at: 80 },
      { kind: 'final-chord', at: 96 },
    ],
    text: [
      { at: 0, until: 16, text: 'Remember this board.' },
      { at: 66, until: 80, text: 'Did you see it?' },
      { at: 88, until: Infinity, text: 'Top 1%? Prove it.' },
    ],
    camera: [
      { at: 0, view: view(HOME_AZIMUTH) },
      { at: 12, view: view(HOME_AZIMUTH + 4) },
      { at: 17, view: keypadView(HOME_AZIMUTH + 8) },
      { at: 32, view: keypadView(HOME_AZIMUTH + 40) },
      { at: 50, view: keypadView(HOME_AZIMUTH + 44, ELEVATION + 4, 0.78) },
      { at: 62, view: keypadView(HOME_AZIMUTH + 46, ELEVATION + 4, 0.78) },
      { at: 68, view: view(HOME_AZIMUTH + 50, ELEVATION, 0.86, 0) },
      { at: 80, view: view(HOME_AZIMUTH + 52, ELEVATION, 0.86, 0) },
      { at: 84, view: { ...END_VIEW, azimuth: HOME_AZIMUTH + 54 } },
    ],
    stills: [
      { name: 'hook', at: 4 },
      { name: 'recall', at: 38 },
      { name: 'threat', at: 54 },
      { name: 'reveal', at: 70 },
    ],
  },
  // Variant C "64 · 76 · 0": 5 bars and the final chord, 9.6 s. The numbers of the game first, then the board
  // shatters, and the rest of the game plays from memory, fast.
  numbers: {
    cut: 'full',
    seconds: 9.6,
    firstMove: 7,
    events: [
      { kind: 'all-lines', at: 6 },
      { kind: 'shatter', at: 12 },
      { kind: 'keypad', at: 16, until: 52 },
      { kind: 'mask', at: 16 },
      ...moves(7, [20, 26, 30]),
      { kind: 'threats', at: 32 },
      ...moves(10, [40, 44, 50]),
      { kind: 'reveal', at: 52 },
      { kind: 'end-card', at: 64 },
      { kind: 'final-chord', at: 80 },
    ],
    text: [
      { at: 1, until: 16, text: '64 cells. 76 ways to win.' },
      { at: 18, until: 32, text: 'Zero on screen.' },
      { at: 72, until: Infinity, text: 'Top 1%? Prove it.' },
    ],
    camera: [
      { at: 0, view: view(HOME_AZIMUTH) },
      { at: 12, view: view(HOME_AZIMUTH + 8) },
      { at: 17, view: keypadView(HOME_AZIMUTH + 12) },
      { at: 38, view: keypadView(HOME_AZIMUTH + 22, ELEVATION + 4, 0.78) },
      { at: 50, view: keypadView(HOME_AZIMUTH + 26, ELEVATION + 4, 0.78) },
      { at: 56, view: view(HOME_AZIMUTH + 30, ELEVATION, 0.86, 0) },
      { at: 64, view: view(HOME_AZIMUTH + 32, ELEVATION, 0.86, 0) },
      { at: 68, view: { ...END_VIEW, azimuth: HOME_AZIMUTH + 34 } },
    ],
    stills: [
      { name: 'hook', at: 9 },
      { name: 'memory', at: 22 },
      { name: 'threat', at: 42 },
    ],
  },
  // Variant A with the Hide coordinates proposal (option 1 of the question on #130): the game plays with Hide board
  // and Hide history, so the slots show each move. The Coordinates button switches on just before the reveal.
  'next-level': {
    cut: 'full',
    seconds: 13,
    firstMove: 5,
    events: [
      { kind: 'shatter', at: 4 },
      { kind: 'keypad', at: 16, until: 80 },
      ...moves(5, [20, 28, 32, 38, 42]),
      { kind: 'threats', at: 48 },
      ...moves(10, [60, 64, 72]),
      { kind: 'mask', at: 74, toggle: true },
      { kind: 'reveal', at: 80 },
      { kind: 'end-card', at: 96 },
      { kind: 'final-chord', at: 112 },
    ],
    text: [
      { at: 2, until: 18, text: "Win a game you can't see?" },
      { at: 82, until: 96, text: 'That was all memory.' },
      { at: 104, until: Infinity, text: 'Top 1%? Prove it.' },
    ],
    camera: [
      { at: 0, view: view(HOME_AZIMUTH) },
      { at: 12, view: view(HOME_AZIMUTH + 6) },
      { at: 17, view: keypadView(HOME_AZIMUTH + 10) },
      { at: 48, view: keypadView(HOME_AZIMUTH + 22) },
      { at: 60, view: keypadView(HOME_AZIMUTH + 30, ELEVATION + 4, 0.78) },
      { at: 78, view: keypadView(HOME_AZIMUTH + 34, ELEVATION + 4, 0.78) },
      { at: 84, view: view(HOME_AZIMUTH + 38, ELEVATION, 0.86, 0) },
      { at: 96, view: view(HOME_AZIMUTH + 40, ELEVATION, 0.86, 0) },
      { at: 100, view: END_VIEW },
    ],
    stills: [
      { name: 'memory', at: 40 },
      { name: 'next-level', at: 75 },
      { name: 'next-level-done', at: 78 },
    ],
  },
};

export function planOf(id: PlanId): Plan {
  return { id, ...PLANS[id] };
}

const isPlanId = (name: string): name is PlanId => (PLAN_IDS as readonly string[]).includes(name);
const requested = globalThis.process?.env?.['MEMORY_PLAN'] ?? 'full';
if (!isPlanId(requested)) throw new Error(`MEMORY_PLAN=${requested} is not one of ${PLAN_IDS.join(', ')}`);
export const PLAN = planOf(requested);
export const DURATION_FRAMES = Math.round(PLAN.seconds * FPS);
// The end in sixteenths.
export const END = PLAN.seconds / SIXTEENTH;

type EventOf<K extends MemoryEvent['kind']> = Extract<MemoryEvent, { kind: K }>;
export const eventsOf = <K extends MemoryEvent['kind']>(kind: K, plan: Plan = PLAN): EventOf<K>[] =>
  plan.events.filter((event): event is EventOf<K> => event.kind === kind);
export function eventOf<K extends MemoryEvent['kind']>(kind: K, plan: Plan = PLAN): EventOf<K> {
  const [event, ...more] = eventsOf(kind, plan);
  if (event === undefined || more.length > 0) throw new Error(`the ${plan.id} plan needs exactly one ${kind} event`);
  return event;
}

// The sixteenths where an X move types its digits, in order.
export const typingOf = (event: EventOf<'move'>): readonly number[] => (playerOf(event.move) === 'X' ? [3, 2, 1].map((k) => event.at - k * event.gap) : []);

// The frames of the stills of a plan.
export const stillsOf = (plan: Plan = PLAN): { name: string; frame: number }[] => {
  const last = Math.round(plan.seconds * FPS) - 1;
  return plan.stills.map((still) => ({ name: still.name, frame: Math.min(last, frameOf(still.at)) }));
};

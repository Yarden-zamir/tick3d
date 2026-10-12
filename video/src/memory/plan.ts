// The plan of the smart-memory ad (issue #130): what shows and when, on the beat grid of src/grid.ts (sixteenths
// of the 136 BPM song, 16 to a bar). It comes in two cuts: 'full' (at most 15.0 s) and 'short' (at most 8.0 s).
// MEMORY_CUT picks one; scripts/memory.ts passes it into the render browser. The plan is variant A "Shatter" of
// the storyboards on #130. A maintainer pick of another variant replaces the event lists below.
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import { ELEVATION, HOME_AZIMUTH } from '../rig.ts';
import { MOVES, playerOf } from './game.ts';

export const CUTS = ['full', 'short'] as const;
export type Cut = (typeof CUTS)[number];

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
  // The slots spin to `? ? ?` and show the last move so from then on: Hide coordinates.
  | { kind: 'mask'; at: number }
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
  cut: Cut;
  seconds: number;
  // The board at the first frame: the moves before this one are on it.
  firstMove: number;
  events: readonly MemoryEvent[];
  text: readonly TextLine[];
  // Camera keys: the camera eases from one key to the next.
  camera: readonly { at: number; view: View }[];
};

const view = (azimuth: number, elevation = ELEVATION, zoom = 0.82, lift = 0.1): View => ({ azimuth, elevation, zoom, lift });
// The end card: the tower small in the middle, the line above it and the address under it.
const END_VIEW: View = { azimuth: HOME_AZIMUTH + 40, elevation: ELEVATION, zoom: 0.5, lift: 0.08 };

// The moves from `from` on, at the given sixteenths. An X move types over the 3 sixteenths before its place.
const moves = (from: number, ats: readonly number[]): MemoryEvent[] => ats.map((at, i) => ({ kind: 'move', at, move: from + i, gap: 1 }));

const PLANS: Readonly<Record<Cut, Omit<Plan, 'cut'>>> = {
  // 7 bars and the final chord: 13.0 s.
  full: {
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
      { at: 48, view: view(HOME_AZIMUTH + 22) },
      { at: 60, view: view(HOME_AZIMUTH + 30, ELEVATION + 4, 0.95) },
      { at: 78, view: view(HOME_AZIMUTH + 34, ELEVATION + 4, 0.95) },
      { at: 84, view: view(HOME_AZIMUTH + 38, ELEVATION, 0.86, 0) },
      { at: 96, view: view(HOME_AZIMUTH + 40, ELEVATION, 0.86, 0) },
      { at: 100, view: END_VIEW },
    ],
  },
  // 4 bars and the final chord: 7.6 s. The board shatters, the keypad shows `? ? ?`, X types the win, the board
  // snaps back, the end card.
  short: {
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
      { at: 30, view: view(HOME_AZIMUTH + 14, ELEVATION + 4, 0.92) },
      { at: 36, view: view(HOME_AZIMUTH + 18, ELEVATION, 0.86, 0) },
      { at: 48, view: view(HOME_AZIMUTH + 22, ELEVATION, 0.86, 0) },
      { at: 52, view: END_VIEW },
    ],
  },
};

export function planOf(cut: Cut): Plan {
  return { cut, ...PLANS[cut] };
}

const isCut = (name: string): name is Cut => (CUTS as readonly string[]).includes(name);
const requested = globalThis.process?.env?.['MEMORY_CUT'] ?? 'full';
if (!isCut(requested)) throw new Error(`MEMORY_CUT=${requested} is not one of ${CUTS.join(', ')}`);
export const PLAN = planOf(requested);
export const DURATION_FRAMES = Math.round(PLAN.seconds * FPS);
// The end in sixteenths.
export const END = PLAN.seconds / SIXTEENTH;

type EventOf<K extends MemoryEvent['kind']> = Extract<MemoryEvent, { kind: K }>;
export const eventsOf = <K extends MemoryEvent['kind']>(kind: K, plan: Plan = PLAN): EventOf<K>[] =>
  plan.events.filter((event): event is EventOf<K> => event.kind === kind);
export function eventOf<K extends MemoryEvent['kind']>(kind: K, plan: Plan = PLAN): EventOf<K> {
  const [event, ...more] = eventsOf(kind, plan);
  if (event === undefined || more.length > 0) throw new Error(`the ${plan.cut} plan needs exactly one ${kind} event`);
  return event;
}

// The sixteenths where an X move types its digits, in order.
export const typingOf = (event: EventOf<'move'>): readonly number[] => (playerOf(event.move) === 'X' ? [3, 2, 1].map((k) => event.at - k * event.gap) : []);

// The still of each event that changes the picture, and of the double threat: for the review sheet and the covers.
export const stillsOf = (plan: Plan = PLAN): { name: string; frame: number }[] => {
  const end = Math.round(plan.seconds * FPS) - 1;
  const at = (name: string, s16: number) => ({ name, frame: Math.min(end, frameOf(s16)) });
  const threats = eventOf('threats', plan);
  const fork = eventsOf('move', plan).find((event) => event.move === MOVES.length - 3);
  return [
    at('hook', eventOf('shatter', plan).at + 2),
    at('memory', eventOf('mask', plan).at + 2),
    at('threat', (fork?.at ?? threats.at + 10) + 2),
    at('reveal', eventOf('reveal', plan).at + 6),
    at('end-card', end / (FPS * SIXTEENTH)),
  ];
};

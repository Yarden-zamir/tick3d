// The plans of the smart-memory ad (issue #130): what shows and when, on the beat grid of src/grid.ts (sixteenths
// of the 136 BPM song, 16 to a bar). Each plan is a 'full' cut (at most 15.0 s) or a 'short' cut (at most 8.0 s).
// MEMORY_PLAN picks one; scripts/memory.ts passes it into the render browser. Both are variant A "Shatter" of the
// storyboards on #130, without Hide coordinates: the maintainers picked this from finished videos (#130). With the
// board and the coordinates both hidden, only the sound of a move tells where it went, and the ad shows no sound.
import { SIXTEENTH } from '../../../src/song.ts';
import { FPS, frameOf } from '../grid.ts';
import { ELEVATION, HOME_AZIMUTH } from '../rig.ts';
import { playerOf } from './game.ts';

export const PLAN_IDS = ['full', 'short'] as const;
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
  // The trails of the X marks light, and the two lines of the double threat draw through them.
  | { kind: 'threats'; at: number }
  // The whole board snaps back with every mark, and the winning line burns across the cube.
  | { kind: 'reveal'; at: number }
  // The wordmark and the address (lettering.ts endCard), the tower shrinks into the top half.
  | { kind: 'end-card'; at: number }
  // A layer of the tower bumps on its Classic note: the four rising notes of the end card, as in the spot.
  | { kind: 'layer-pulse'; at: number; layer: number }
  | { kind: 'final-chord'; at: number };

// A line of text in the top band of the square. It wraps into rows when it does not fit the width.
type TextLine = { at: number; until: number; text: string };

export type Plan = {
  id: PlanId;
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
// While the keypad shows, the tower sits small in the top part of the square, above the keypad. `push` zooms in.
const keypadView = (azimuth: number, elevation = ELEVATION, push = 0): View => view(azimuth, elevation, 0.7 + push, 0.34);
// The end card: the tower small in the middle, the line above it and the address under it.
const END_VIEW: View = { azimuth: HOME_AZIMUTH + 40, elevation: ELEVATION, zoom: 0.5, lift: 0.08 };

// The four layers bump from the bottom up, one per beat from `at`, before the final chord (the spot, music.md).
const endNotes = (at: number): MemoryEvent[] => [0, 1, 2, 3].map((layer) => ({ kind: 'layer-pulse', at: at + layer * 4, layer }));

// The moves from `from` on, at the given sixteenths. An X move types over the 3 sixteenths before its place.
const moves = (from: number, ats: readonly number[]): MemoryEvent[] => ats.map((at, i) => ({ kind: 'move', at, move: from + i, gap: 1 }));

// The 7 bars of the full cut and the final chord: 13.0 s. The board shatters, the memory load, the double threat,
// the reveal, the end card.
function fullCut(): Omit<Plan, 'id'> {
  return {
    seconds: 13,
    firstMove: 5,
    events: [
      { kind: 'shatter', at: 4 },
      { kind: 'keypad', at: 16, until: 80 },
      // Bars 2 and 3: the memory load. O 3 3 2, X 1 4 4, O 1 4 1, X 2 3 3, O 3 2 2.
      ...moves(5, [20, 28, 32, 38, 42]),
      // Bars 4 and 5: the double threat, X 2 4 3, O blocks at 2 1 3, X wins on 3 4 2.
      { kind: 'threats', at: 48 },
      ...moves(10, [60, 64, 72]),
      { kind: 'reveal', at: 80 },
      { kind: 'end-card', at: 96 },
      ...endNotes(96),
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
      { at: 60, view: keypadView(HOME_AZIMUTH + 30, ELEVATION + 4, 0.08) },
      { at: 78, view: keypadView(HOME_AZIMUTH + 34, ELEVATION + 4, 0.08) },
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
  };
}

// The 4 bars of the short cut and the final chord: 7.6 s. The board shatters, the keypad, X types the win, the
// board snaps back, the end card.
function shortCut(): Omit<Plan, 'id'> {
  return {
    seconds: 7.6,
    firstMove: 12,
    events: [
      { kind: 'shatter', at: 4 },
      { kind: 'keypad', at: 14, until: 32 },
      { kind: 'threats', at: 18 },
      ...moves(12, [26]),
      { kind: 'reveal', at: 32 },
      { kind: 'end-card', at: 48 },
      ...endNotes(48),
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
      { at: 30, view: keypadView(HOME_AZIMUTH + 14, ELEVATION + 4, 0.08) },
      { at: 36, view: view(HOME_AZIMUTH + 18, ELEVATION, 0.86, 0) },
      { at: 48, view: view(HOME_AZIMUTH + 22, ELEVATION, 0.86, 0) },
      { at: 52, view: END_VIEW },
    ],
    stills: [
      { name: 'hook', at: 6 },
      { name: 'memory', at: 20 },
      { name: 'threat', at: 27 },
      { name: 'reveal', at: 38 },
      { name: 'end-card', at: 68 },
    ],
  };
}

export function planOf(id: PlanId): Plan {
  return { id, ...(id === 'full' ? fullCut() : shortCut()) };
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

// The timeline of the spot: beats.json, checked, and the game that it shows, rebuilt from the game code.
// Everything here is a function of the frame number, so every render gives the same video.
import beatsJson from '../creative/beats.json' with { type: 'json' };
import { BAR_COUNT, SIXTEENTHS_PER_BAR, parseBeats, withVariant, type Beats } from '../creative/beats.ts';
import { chooseMove } from '../../src/ai.ts';
import { type Board, type Game, newGame, play, replay } from '../../src/game.ts';
import { seededRandom } from '../../src/practice/practice.ts';
import { FPS, frameOf } from './grid.ts';
import { toEpochMs } from '../../src/epoch.ts';

// The move times of the game. The spot never reads them, and a fixed time keeps Date.now() out.
const NO_TIME = toEpochMs(0);

import hook from '../creative/variants/hook.json' with { type: 'json' };
import hookList from '../creative/variants/hook-list.json' with { type: 'json' };

// The variants of the spot: VIDEO_VARIANT picks an overlay of video/creative/variants/. Unset, or 'classic', is
// the approved cut. scripts/render.ts passes the variable into the render browser.
export const VARIANTS = { classic: undefined, hook, 'hook-list': hookList } as const;
export type VariantName = keyof typeof VARIANTS;
const isVariantName = (name: string): name is VariantName => Object.hasOwn(VARIANTS, name);
const requested = globalThis.process?.env?.['VIDEO_VARIANT'] ?? 'classic';
if (!isVariantName(requested)) throw new Error(`VIDEO_VARIANT=${requested} is not one of ${Object.keys(VARIANTS).join(', ')}`);
export const VARIANT: VariantName = requested;
const overlay = VARIANTS[VARIANT];

export const BEATS: Beats = parseBeats(overlay === undefined ? beatsJson : withVariant(beatsJson, overlay));
// The grid of src/grid.ts. beats.json has fps 30, the frame rate of the grid (parseBeats checks it).
export { FPS, S16_FRAMES, frameOf, since } from './grid.ts';
export const DURATION_FRAMES = BEATS.durationSeconds * FPS;

type Bar = Beats['bars'][number];

// The bar of a frame. The final chord after the 8 bars stays in bar 8.
export function barAt(frame: number): Bar {
  let index = 0;
  for (let i = 1; i < BAR_COUNT; i++) if (frame >= frameOf(i * SIXTEENTHS_PER_BAR)) index = i;
  const bar = BEATS.bars[index];
  if (bar === undefined) throw new RangeError(`beats.json has no bar ${index + 1}`);
  return bar;
}

// The bar before `bar`, or undefined for bar 1.
export const barBefore = (bar: Bar): Bar | undefined => BEATS.bars[bar.bar - 2];

type BeatEvent = Bar['events'][number];
type EventOf<K extends BeatEvent['kind']> = Extract<BeatEvent, { kind: K }>;

export function eventsOf<K extends BeatEvent['kind']>(kind: K): EventOf<K>[] {
  return BEATS.bars.flatMap((bar) => bar.events.filter((event): event is EventOf<K> => event.kind === kind));
}

// The one event of a kind. The spot is built for exactly one beam, one confetti burst and so on.
export function eventOf<K extends BeatEvent['kind']>(kind: K): EventOf<K> {
  const [event, ...rest] = eventsOf(kind);
  if (event === undefined || rest.length > 0) throw new Error(`beats.json needs exactly one ${kind} event`);
  return event;
}

// The self-play game of src/ai.ts with the seed of beats.json, as tools/check-beats.ts plays it.
function selfPlay(): Game {
  const random = seededRandom(BEATS.game.seed);
  let game = newGame(BEATS.game.first);
  while (game.status.kind === 'playing') {
    const result = play(game, chooseMove(game.board, game.turn, BEATS.game.levels[game.turn], random), NO_TIME);
    if (!result.ok) throw new Error(`self-play made an illegal move: ${result.error}`);
    game = result.game;
  }
  return game;
}

// The finished game. It throws when beats.json shows other moves than the seed plays.
export const GAME: Game = (() => {
  const game = selfPlay();
  const cells = BEATS.moves.map((move) => move.cell);
  if (JSON.stringify(game.moves) !== JSON.stringify(cells)) throw new Error('beats.json moves differ from the self-play game of its seed');
  return game;
})();

// The moves on the board at a frame: a move counts from the frame of its sixteenth.
const movesAt = (frame: number) => BEATS.moves.filter((move) => frame >= frameOf(move.at));

export const boardAt = (frame: number): Board => replay(movesAt(frame).map((move) => move.cell), { first: BEATS.game.first }).board;

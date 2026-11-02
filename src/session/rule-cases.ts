// Rule cases: the results of the online session rules (./core.ts) and the board rules (../game.ts) as JSON data.
// A second copy of the rules (the Rust server, #265) runs the same cases and must give the same results.
// The TypeScript rules are the source: rule-cases.test.ts fails when they give other results than the stored files.
// Limit: only the online mode, because only the server holds online sessions. Revisit if a second copy needs
// the local, computer or Nearby modes.
import { LINES, type Line, type Player, lineKind, replay } from '../game.ts';
import { nameOf } from '../names.ts';
import { PRESET_IDS } from '../practice/practice.ts';
import type { PlayoffRequest } from '../practice/playoff.ts';
import { type Code, type MoveRequest, type PersonId, type SeatAction, type SessionUpdate, seatIn } from '../protocol.ts';
import { toEpochMs } from '../epoch.ts';
import type { TimeControl } from '../clock.ts';
import * as core from './core.ts';
import type { SessionDoc } from './format.ts';

// A watcher as the holder of the session knows it. JSON has no functions, so names and person ids are tables.
type Watcher = core.OpenWatcher;
type Audience = { presence: Record<Player, boolean>; watchers: Watcher[]; names: Record<string, string>; persons: Record<string, PersonId | null> };

type Action =
  | { op: 'join'; identity: string[]; token: string }
  | { op: 'move'; identity: string[]; request: MoveRequest; now: number }
  | { op: 'newGame'; identity: string[] }
  | { op: 'update'; identity: string[]; changes: SessionUpdate }
  | { op: 'lock'; identity: string[] }
  | { op: 'chat'; identity: string[]; text: string; now: number; author: PersonId | null; watchers: Watcher[] }
  | { op: 'playoff'; identity: string[]; request: PlayoffRequest; now: number }
  | { op: 'seat'; identity: string[]; request: SeatAction; watchers: Watcher[]; now: number }
  | { op: 'answerSeat'; identity: string[]; accept: boolean; watchers: Watcher[]; now: number }
  // `settle` and `abandonLive` give no document when nothing changes: the result is then "unchanged".
  | { op: 'settle'; now: number }
  | { op: 'abandonLive' }
  | { op: 'view'; identity: string[]; code: Code; version: number; now: number; audience: Audience };

type Result = { doc: SessionDoc } | { unchanged: true } | { view: unknown } | { error: { status: number; message: string; code: string | null } };
type Step = Action & { result: Result };
type SessionCase = { name: string; create: { name: string; clock: TimeControl; seats: Record<Player, string | null> }; start: Result; steps: Step[] };
type ReplayCase = { moves: number[]; first: Player; result: { game: unknown } | { error: string } };
export type RuleCases = {
  sessions: SessionCase[];
  replays: ReplayCase[];
  lines: { line: Line; kind: string }[];
  names: { token: string; name: string }[];
};

function errorOf(error: unknown): Result {
  if (error instanceof core.SessionError) return { error: { status: error.status, message: error.message, code: error.code ?? null } };
  throw error; // a plain Error is a fault of the generator, not a rule
}

const nameFrom = (audience: Audience) => (token: string) => {
  const name = audience.names[token];
  if (name === undefined) throw new Error(`the case gives no name for ${token}`);
  return name;
};

// Applies one action with the TypeScript rules.
function apply(doc: SessionDoc, action: Action): Result {
  const identity = new Set('identity' in action ? action.identity : []);
  try {
    switch (action.op) {
      case 'join':
        return { doc: core.join(doc, identity, action.token) };
      case 'move':
        return { doc: core.move(doc, identity, action.request, toEpochMs(action.now)) };
      case 'newGame':
        return { doc: core.newGame(doc, identity) };
      case 'update':
        return { doc: core.update(doc, identity, action.changes) };
      case 'lock':
        return { doc: core.lock(doc, identity) };
      case 'chat':
        return { doc: core.chat(doc, identity, action.text, toEpochMs(action.now), action.author, action.watchers) };
      case 'playoff':
        return { doc: core.playoff(doc, identity, action.request, action.now) };
      case 'seat':
        return { doc: core.seat(doc, identity, action.request, action.watchers, toEpochMs(action.now)) };
      case 'answerSeat':
        return { doc: core.answerSeat(doc, identity, action.accept, action.watchers, toEpochMs(action.now)) };
      case 'settle': {
        const next = core.settle(doc, toEpochMs(action.now));
        return next === undefined ? { unchanged: true } : { doc: next };
      }
      case 'abandonLive': {
        const next = core.abandonLive(doc);
        return next === undefined ? { unchanged: true } : { doc: next };
      }
      case 'view': {
        const { audience } = action;
        const view = core.viewOf(doc, {
          code: action.code,
          version: action.version,
          identity,
          now: toEpochMs(action.now),
          audience: { presence: audience.presence, watchers: audience.watchers, name: nameFrom(audience), person: (token) => audience.persons[token] ?? null },
          players: { X: null, O: null },
        });
        return { view };
      }
    }
  } catch (error) {
    return errorOf(error);
  }
}

// Plays a case again with the TypeScript rules, and returns it with their results.
function run(name: string, create: SessionCase['create'], actions: readonly Action[]): SessionCase {
  let start: Result;
  try {
    start = { doc: core.createDoc({ ...create, mode: 'online' }) };
  } catch (error) {
    start = errorOf(error);
  }
  let doc = 'doc' in start ? start.doc : undefined;
  const steps: Step[] = [];
  for (const action of actions) {
    if (doc === undefined) throw new Error(`case ${name} has steps after a failed create`);
    const result = apply(doc, action);
    steps.push({ ...action, result });
    if ('doc' in result) doc = result.doc;
  }
  return { name, create, start, steps };
}

// ---- The seeded random play ----

// mulberry32: a small seeded generator, so each seed gives the same games on every machine.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TOKENS = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'];
const CLOCKS: TimeControl[] = [{ perMove: null, perGame: null }, { perMove: 10, perGame: null }, { perMove: null, perGame: 60 }, { perMove: 5, perGame: 120 }];
const START = 1_800_000_000_000;

// One random online session: about `length` actions by four devices, with times that move on by up to 90 s,
// and now and then by 10 minutes, so clocks run out and seat requests end.
function randomCase(seed: number, length: number): SessionCase {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  };
  const chance = (p: number) => next() < p;
  // A device, and now and then two devices of one account.
  const identity = () => (chance(0.08) ? [pick(TOKENS), pick(TOKENS)] : [pick(TOKENS)]);
  // Most actions come from a seated player, else random play rarely gets past the first refusals.
  const player = (seat?: Player) => {
    const holder = seat === undefined ? doc.seats[chance(0.5) ? 'X' : 'O'] : doc.seats[seat];
    return holder !== null && chance(0.85) ? [holder] : identity();
  };
  const watchers = (): Watcher[] => TOKENS.filter(() => chance(0.5)).map((token) => ({ id: `w-${token.slice(0, 8)}`, token, player: null }));
  const create = { name: `Random ${seed}`, clock: pick(CLOCKS), seats: { X: TOKENS[0] ?? null, O: null } };
  let now = START;
  // The rules run while the case is built, so a move can aim at the live game most of the time.
  let doc = core.createDoc({ ...create, mode: 'online' });
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) {
    now += chance(0.03) ? 600_000 : Math.floor(next() * (chance(0.1) ? 90_000 : 6_000));
    const live = doc.games.length - 1;
    const game = doc.games[live];
    if (game === undefined) throw new Error('a session without a game');
    const roll = next();
    let action: Action;
    if (roll < 0.45) {
      const empty = [...Array(64).keys()].filter((cell) => !game.moves.includes(cell));
      const cell = chance(0.9) && empty.length > 0 ? pick(empty) : Math.floor(next() * 64);
      const request = { game: chance(0.95) ? live : Math.max(0, live - 1), moveCount: chance(0.9) ? game.moves.length : Math.max(0, game.moves.length - 1), cell };
      action = { op: 'move', identity: player(seatIn(doc.flipped, live, core.currentGame(doc).turn)), request, now };
    } else if (roll < 0.5) action = { op: 'join', identity: identity(), token: pick(TOKENS) };
    else if (roll < 0.56) action = { op: 'newGame', identity: player() };
    else if (roll < 0.61) {
      const changes: SessionUpdate = pick<SessionUpdate>([
        { hideBoard: chance(0.5) },
        { hideHistory: chance(0.5), hideCoordinates: chance(0.5) },
        { clock: pick(CLOCKS) },
        { fixedSeats: chance(0.5) },
        { watcherChat: chance(0.5) },
        { name: pick(['Rematch', '  spaced  ', '', 'x'.repeat(41)]) },
      ]);
      action = { op: 'update', identity: player(), changes };
    } else if (roll < 0.64) action = { op: 'lock', identity: player() };
    else if (roll < 0.69) {
      const author = chance(0.7) ? (`person-${Math.floor(next() * 3)}` as PersonId) : null;
      action = { op: 'chat', identity: identity(), text: pick(['gg', 'nice move', '', ' '.repeat(3), 'y'.repeat(300)]), now, author, watchers: watchers() };
    } else if (roll < 0.73) {
      const id = 1 + Math.floor(next() * 2);
      const request: PlayoffRequest = pick<PlayoffRequest>([
        { action: 'start', preset: pick(PRESET_IDS), seed: Math.floor(next() * 1000) },
        { action: 'join', id },
        { action: 'leave', id },
        { action: 'hit', id, index: Math.floor(next() * 4), ms: Math.floor(next() * 2000) },
      ]);
      action = { op: 'playoff', identity: player(), request, now };
    } else if (roll < 0.83) {
      const watcher = `w-${pick(TOKENS).slice(0, 8)}`;
      const request: SeatAction = pick<SeatAction>([
        { action: 'swap' },
        { action: 'leave' },
        { action: 'unseat' },
        { action: 'undo' },
        { action: 'give', watcher },
        { action: 'seat', watcher },
        { action: 'replace', watcher },
      ]);
      action = { op: 'seat', identity: player(), request, watchers: watchers(), now };
    } else if (roll < 0.9) {
      const asked = doc.seatRequest?.from;
      action = { op: 'answerSeat', identity: player(asked === undefined ? undefined : asked === 'X' ? 'O' : 'X'), accept: chance(0.6), watchers: watchers(), now };
    }
    else if (roll < 0.94) action = { op: 'settle', now };
    else if (roll < 0.945) action = { op: 'abandonLive' };
    else {
      const watching = watchers();
      const names = Object.fromEntries(TOKENS.map((token) => [token, chance(0.3) ? `Name ${token.slice(0, 1)}` : nameOf(token)]));
      const persons = Object.fromEntries(TOKENS.map((token) => [token, chance(0.8) ? (`person-${token.slice(0, 1)}` as PersonId) : null]));
      const audience: Audience = { presence: { X: chance(0.7), O: chance(0.7) }, watchers: watching, names, persons };
      action = { op: 'view', identity: identity(), code: 'ABCD' as Code, version: i, now, audience };
    }
    actions.push(action);
    const result = apply(doc, action);
    if ('doc' in result) doc = result.doc;
  }
  return run(`random ${seed}`, create, actions);
}

// ---- Written cases: what random play rarely reaches ----

function writtenCases(): SessionCase[] {
  const [a, b, c] = TOKENS as [string, string, string];
  const seats = { X: a, O: null };
  const noLimit = { perMove: null, perGame: null };
  const watchers: Watcher[] = [{ id: 'w-cccccccc', token: c, player: null }];
  const audience: Audience = { presence: { X: true, O: true }, watchers, names: { [a]: 'Ann', [b]: nameOf(b), [c]: nameOf(c) }, persons: { [a]: 'person-a' as PersonId, [b]: null, [c]: null } };
  const view = (identity: string[], now: number): Action => ({ op: 'view', identity, code: 'WXYZ' as Code, version: 1, now, audience });
  // X wins on a straight line, then plays again: the seats swap in the next game.
  const xWins = [0, 1, 16, 2, 32, 3, 48];
  const won: Action[] = [
    { op: 'join', identity: [b], token: b },
    ...xWins.map((cell, i): Action => ({ op: 'move', identity: [i % 2 === 0 ? a : b], request: { game: 0, moveCount: i, cell }, now: START + i * 1000 })),
    view([a], START + 8000),
    view([c], START + 8000),
    { op: 'move', identity: [b], request: { game: 0, moveCount: 7, cell: 5 }, now: START + 9000 },
    { op: 'newGame', identity: [b] },
    { op: 'move', identity: [b], request: { game: 1, moveCount: 0, cell: 5 }, now: START + 10_000 },
    view([b], START + 10_000),
  ];
  // The clocks start after the first move of each player. Then the player to move runs out of time: settle records
  // the timeout once, and a late move fails.
  const timeout: Action[] = [
    { op: 'join', identity: [b], token: b },
    { op: 'move', identity: [a], request: { game: 0, moveCount: 0, cell: 0 }, now: START },
    { op: 'move', identity: [b], request: { game: 0, moveCount: 1, cell: 1 }, now: START + 30_000 },
    { op: 'settle', now: START + 39_000 },
    view([a], START + 39_000),
    { op: 'settle', now: START + 41_000 },
    { op: 'settle', now: START + 42_000 },
    { op: 'move', identity: [a], request: { game: 0, moveCount: 2, cell: 2 }, now: START + 43_000 },
    view([a], START + 43_000),
  ];
  // Requests to the other player: a swap accepted, an undo accepted, a watcher put on a seat, one that ends unanswered.
  const requests: Action[] = [
    { op: 'join', identity: [b], token: b },
    { op: 'move', identity: [a], request: { game: 0, moveCount: 0, cell: 0 }, now: START },
    { op: 'seat', identity: [a], request: { action: 'undo' }, watchers, now: START + 1000 },
    view([b], START + 1000),
    { op: 'answerSeat', identity: [b], accept: true, watchers, now: START + 2000 },
    { op: 'seat', identity: [a], request: { action: 'swap' }, watchers, now: START + 3000 },
    { op: 'answerSeat', identity: [b], accept: true, watchers, now: START + 4000 },
    { op: 'seat', identity: [a], request: { action: 'replace', watcher: 'w-cccccccc' }, watchers, now: START + 5000 },
    { op: 'answerSeat', identity: [b], accept: true, watchers, now: START + 6000 },
    { op: 'seat', identity: [a], request: { action: 'unseat' }, watchers, now: START + 7000 },
    { op: 'answerSeat', identity: [c], accept: true, watchers, now: START + 7000 + core.SEAT_REQUEST_MS },
    { op: 'settle', now: START + 8000 + core.SEAT_REQUEST_MS },
    view([a], START + 8000 + core.SEAT_REQUEST_MS),
  ];
  return [
    run('X wins, and the next game swaps the seats', { name: 'Won', clock: noLimit, seats }, won),
    run('a move clock runs out', { name: 'Timeout', clock: { perMove: 10, perGame: null }, seats }, timeout),
    run('seat requests', { name: 'Requests', clock: noLimit, seats }, requests),
  ];
}

// ---- All cases ----

const RANDOM_SEEDS = 40;
const RANDOM_LENGTH = 80;

export function allCases(): RuleCases {
  const sessions = [...Array(RANDOM_SEEDS).keys()].map((seed) => randomCase(seed + 1, RANDOM_LENGTH));
  sessions.push(...writtenCases());
  // Bad session names fail at the start.
  sessions.push(run('a name of 41 characters', { name: 'n'.repeat(41), clock: CLOCKS[0] ?? { perMove: null, perGame: null }, seats: { X: TOKENS[0] ?? null, O: null } }, []));
  // Uploads replay their moves: legal games, and moves that the board refuses.
  const replays: ReplayCase[] = [
    { moves: [0, 1, 16, 2, 32, 3, 48], first: 'X' },
    { moves: [0, 21, 1, 42, 2, 63, 4, 5], first: 'O' },
    { moves: [0, 0], first: 'X' },
    { moves: [0, 1, 16, 2, 32, 3, 48, 5], first: 'X' },
  ].map(({ moves, first }) => {
    try {
      return { moves, first: first as Player, result: { game: replay(moves, { first: first as Player }) } };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { moves, first: first as Player, result: { error: error.message } };
    }
  });
  return {
    sessions,
    replays,
    lines: LINES.map((line) => ({ line, kind: lineKind(line) })),
    names: TOKENS.map((token) => ({ token, name: nameOf(token) })),
  };
}

// The ear training schedule: which card comes next, and what the player hears well.
// It uses Leitner boxes with intervals counted in cards, so it works in one session and across sessions.
// The page keeps no clock: a card that the player finishes is one step of time.
import { isCount, isRecord } from '../guards.ts';
import type { Random } from '../ai.ts';
import { CELL_COUNT, SIZE, toCell, toCoords, type Coords } from '../game.ts';

export const DIMENSIONS = ['layer', 'row', 'column'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Value = 0 | 1 | 2 | 3;
export const VALUES: readonly Value[] = [0, 1, 2, 3];
// One sound part, for example "row-1": the second instrument.
export type ItemId = `${Dimension}-${Value}`;
export const ITEMS: readonly ItemId[] = DIMENSIONS.flatMap((dimension) => VALUES.map((value): ItemId => `${dimension}-${value}`));

// `learn` counts the learn cards that the item still shows with its answer. At 0 the item is in the quiz.
type Item = { learn: number; box: Box; due: number };
export type Progress = {
  version: 1;
  // The number of finished cards.
  turn: number;
  // Only the items that the player saw. A missing item is new.
  items: Partial<Record<ItemId, Item>>;
  // The last answers per dimension, oldest first. true is a right answer.
  recent: Record<Dimension, boolean[]>;
  // The item of the last card, so the next card is a different one when it can be.
  last: ItemId | null;
};

export type Card = { kind: 'learn' | 'quiz'; item: ItemId; cell: number } | { kind: 'full'; cell: number };

export const LEARN_VIEWS = 2;
// The cards to wait before an item in this box comes back. A wrong answer sends the item to box 0.
const INTERVALS = [2, 4, 10, 25, 60] as const;
export const BOX_COUNT = INTERVALS.length;
// A Leitner box: an index of INTERVALS.
type Box = 0 | 1 | 2 | 3 | 4;
const BOXES = [0, 1, 2, 3, 4] as const satisfies readonly Box[] & { length: typeof BOX_COUNT };
// A right answer moves the item one box up. The last box keeps it.
const NEXT_BOX = [1, 2, 3, 4, 4] as const satisfies Record<Box, Box>;
export const RECENT_SIZE = 20;
// New items join only while fewer than this many items are still in learn or in box 0.
const MAX_UNSTEADY = 3;
// At most this share of the cards asks for a full cell, when every dimension is at 100%.
const MAX_FULL_SHARE = 0.6;

export function freshProgress(): Progress {
  return { version: 1, turn: 0, items: {}, recent: { layer: [], row: [], column: [] }, last: null };
}

export function splitItem(item: ItemId): { dimension: Dimension; value: Value } {
  const [dimension, value] = item.split('-');
  const found = DIMENSIONS.find((name) => name === dimension);
  const number = VALUES.find((known) => known === Number(value));
  if (found === undefined || number === undefined) throw new RangeError(`not an item: ${item}`);
  return { dimension: found, value: number };
}

function itemOf(dimension: Dimension, value: number): ItemId {
  const known = VALUES.find((option) => option === value);
  if (known === undefined) throw new RangeError(`not a ${dimension} value: ${value}`);
  return `${dimension}-${known}`;
}

// The share of right answers in the recent answers of a dimension, or undefined without answers.
export function accuracy(progress: Progress, dimension: Dimension): number | undefined {
  const recent = progress.recent[dimension];
  if (recent.length === 0) return undefined;
  return recent.filter(Boolean).length / recent.length;
}

// The dimension with the lowest accuracy. A dimension without answers does not count.
export function weakest(progress: Progress): Dimension | undefined {
  let found: Dimension | undefined;
  for (const dimension of DIMENSIONS) {
    const value = accuracy(progress, dimension);
    if (value === undefined) continue;
    if (found === undefined || value < (accuracy(progress, found) ?? 1)) found = dimension;
  }
  return found;
}

// A weak dimension gets more cards: an unknown or 0% dimension gets 1.15, a 100% dimension 0.15.
function dimensionWeight(progress: Progress, dimension: Dimension): number {
  return 1.15 - (accuracy(progress, dimension) ?? 0);
}

// The share of full cards. Full cards start when every item is in the quiz, and grow with the weakest dimension.
export function fullShare(progress: Progress): number {
  const allInQuiz = ITEMS.every((item) => progress.items[item]?.learn === 0);
  if (!allInQuiz) return 0;
  return MAX_FULL_SHARE * Math.min(...DIMENSIONS.map((dimension) => accuracy(progress, dimension) ?? 0));
}

// A random cell that has the value of the item. The other two coordinates change, so the player learns
// to hear one part in any sound.
function cellFor(item: ItemId, random: Random): number {
  const { dimension, value } = splitItem(item);
  const coords: Coords = { layer: randomValue(random), row: randomValue(random), column: randomValue(random) };
  coords[dimension] = value;
  return toCell(coords);
}

const randomValue = (random: Random): number => Math.min(SIZE - 1, Math.floor(random() * SIZE));

// Picks a dimension with chance in proportion to its weight, then the item of that dimension that waited longest.
function pickByWeakness(progress: Progress, candidates: readonly ItemId[], random: Random): ItemId | undefined {
  if (candidates.length === 0) return undefined;
  const dimensions = DIMENSIONS.filter((dimension) => candidates.some((item) => splitItem(item).dimension === dimension));
  const weights = dimensions.map((dimension) => dimensionWeight(progress, dimension));
  let roll = random() * weights.reduce((sum, weight) => sum + weight, 0);
  const index = weights.findIndex((weight) => (roll -= weight) < 0);
  const dimension = dimensions[index === -1 ? dimensions.length - 1 : index];
  const due = (item: ItemId) => progress.items[item]?.due ?? 0;
  return candidates.filter((item) => splitItem(item).dimension === dimension).sort((a, b) => due(a) - due(b))[0];
}

// The next new item: from the dimension with the fewest seen items, lowest value first.
function nextNew(progress: Progress): ItemId | undefined {
  const fresh = ITEMS.filter((item) => progress.items[item] === undefined);
  const seen = (dimension: Dimension) => VALUES.filter((value) => progress.items[itemOf(dimension, value)] !== undefined).length;
  return fresh.sort((a, b) => seen(splitItem(a).dimension) - seen(splitItem(b).dimension))[0];
}

const cardFor = (progress: Progress, item: ItemId, random: Random): Card => ({
  kind: (progress.items[item]?.learn ?? LEARN_VIEWS) > 0 ? 'learn' : 'quiz',
  item,
  cell: cellFor(item, random),
});

export function nextCard(progress: Progress, random: Random): Card {
  const fullCard = (): Card => ({ kind: 'full', cell: Math.min(CELL_COUNT - 1, Math.floor(random() * CELL_COUNT)) });
  const share = fullShare(progress);
  if (share > 0 && random() < share) return fullCard();

  const seen = ITEMS.filter((item) => progress.items[item] !== undefined);
  const notLast = seen.filter((item) => item !== progress.last);
  const due = notLast.filter((item) => (progress.items[item]?.due ?? 0) <= progress.turn);
  const dueItem = pickByWeakness(progress, due, random);
  if (dueItem !== undefined) return cardFor(progress, dueItem, random);

  const unsteady = seen.filter((item) => {
    const state = progress.items[item];
    return state !== undefined && (state.learn > 0 || state.box === 0);
  });
  const fresh = nextNew(progress);
  if (fresh !== undefined && unsteady.length < MAX_UNSTEADY) return cardFor(progress, fresh, random);
  if (share > 0) return fullCard();

  // Nothing is due and no new item may join: review the item that comes back first, weak dimensions first.
  const ahead = pickByWeakness(progress, notLast.length > 0 ? notLast : seen, random);
  if (ahead !== undefined) return cardFor(progress, ahead, random);
  // Only a progress without a seen item gets here, and then nextNew always has an item.
  if (fresh === undefined) throw new Error('no card to show');
  return cardFor(progress, fresh, random);
}

function finish(progress: Progress, last: ItemId | null): Progress {
  return { ...progress, turn: progress.turn + 1, last };
}

function remember(recent: Progress['recent'], dimension: Dimension, right: boolean): Progress['recent'] {
  return { ...recent, [dimension]: [...recent[dimension], right].slice(-RECENT_SIZE) };
}

// The player saw a learn card. After LEARN_VIEWS views the item moves to the quiz in box 0.
export function seeLearn(progress: Progress, item: ItemId): Progress {
  const state = progress.items[item] ?? { learn: LEARN_VIEWS, box: 0, due: 0 };
  if (state.learn <= 0) throw new Error(`${item} is not in learn`);
  const done = finish(progress, item);
  const learn = state.learn - 1;
  // A learn card comes back after one other card. The first quiz waits the interval of box 0.
  const due = done.turn + (learn > 0 ? 1 : INTERVALS[0]);
  return { ...done, items: { ...done.items, [item]: { learn, box: 0, due } } };
}

// A quiz answer for one item: right moves it one box up, wrong sends it back to box 0 and keeps it due.
export function answerItem(progress: Progress, item: ItemId, right: boolean): Progress {
  const state = progress.items[item];
  if (state === undefined || state.learn > 0) throw new Error(`${item} is not in the quiz`);
  const done = finish(progress, item);
  const box: Box = right ? NEXT_BOX[state.box] : 0;
  const due = right ? done.turn + INTERVALS[box] : done.turn;
  const recent = remember(done.recent, splitItem(item).dimension, right);
  return { ...done, recent, items: { ...done.items, [item]: { ...state, box, due } } };
}

// A full card answer counts for each dimension. A missed part sends the item of the right value back to box 0.
export function answerFull(progress: Progress, cell: number, guess: Coords): Progress {
  const actual = toCoords(cell);
  const done = finish(progress, null);
  let { recent } = done;
  const items = { ...done.items };
  for (const dimension of DIMENSIONS) {
    const right = guess[dimension] === actual[dimension];
    recent = remember(recent, dimension, right);
    const item = itemOf(dimension, actual[dimension]);
    const state = items[item];
    if (!right && state !== undefined && state.learn === 0) items[item] = { ...state, box: 0, due: done.turn };
  }
  return { ...done, recent, items };
}

// ---- Storage ----

function parseItem(value: unknown): Item | undefined {
  if (!isRecord(value)) return undefined;
  const { learn, due } = value;
  const box = BOXES.find((known) => known === value.box);
  if (!isCount(learn) || learn > LEARN_VIEWS || box === undefined || !isCount(due)) return undefined;
  return { learn, box, due };
}

// Stored progress comes from an older version or a hand edit. Any value that is not valid gives a fresh start.
export function parseProgress(value: unknown): Progress {
  if (!isRecord(value)) return freshProgress();
  const { version, turn, items, recent, last } = value;
  if (version !== 1 || !isCount(turn) || !isRecord(items) || !isRecord(recent)) {
    return freshProgress();
  }
  const parsedItems: Progress['items'] = {};
  for (const [key, state] of Object.entries(items)) {
    const item = ITEMS.find((id) => id === key);
    const parsed = parseItem(state);
    if (item === undefined || parsed === undefined) return freshProgress();
    parsedItems[item] = parsed;
  }
  const parsedRecent = freshProgress().recent;
  for (const dimension of DIMENSIONS) {
    const list = recent[dimension];
    if (!Array.isArray(list) || list.length > RECENT_SIZE || !list.every((entry) => typeof entry === 'boolean')) return freshProgress();
    parsedRecent[dimension] = list;
  }
  const parsedLast = ITEMS.find((id) => id === last) ?? null;
  if (last !== null && parsedLast === null) return freshProgress();
  return { version: 1, turn, items: parsedItems, recent: parsedRecent, last: parsedLast };
}

// ---- Answer area ----

// What a tap on the deck selects: a whole layer, a row or a column through all layers, or one cell.
export type Asked = Dimension | 'cell';

// The cells that a tap on `cell` selects when the card asks for `asked`.
export function areaOf(asked: Asked, cell: number): number[] {
  // toCoords checks that the cell is on the board.
  if (asked === 'cell') return [toCell(toCoords(cell))];
  const value = toCoords(cell)[asked];
  return Array.from({ length: CELL_COUNT }, (_, index) => index).filter((index) => toCoords(index)[asked] === value);
}

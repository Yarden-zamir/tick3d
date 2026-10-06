import { describe, expect, it } from 'vitest';
import { toCoords } from '../game.ts';
import {
  type Card,
  type ItemId,
  type Progress,
  DIMENSIONS,
  ITEMS,
  LEARN_VIEWS,
  answerFull,
  answerItem,
  freshProgress,
  fullShare,
  nextCard,
  parseProgress,
  seeLearn,
  splitItem,
  weakest,
} from './schedule.ts';

// A repeatable random source, so a failing test fails the same way every time.
function seeded(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

// Plays `count` cards. `right` decides each quiz answer.
function play(progress: Progress, count: number, right: (card: Card) => boolean, random = seeded()): { progress: Progress; cards: Card[] } {
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    const card = nextCard(progress, random);
    cards.push(card);
    if (card.kind === 'learn') progress = seeLearn(progress, card.item);
    else if (card.kind === 'quiz') progress = answerItem(progress, card.item, right(card));
    else progress = answerFull(progress, card.cell, right(card) ? toCoords(card.cell) : { layer: 0, row: 0, column: 0 });
  }
  return { progress, cards };
}

// Every item in the quiz in box 1 and due now, with the given recent answers.
function allInQuiz(recent: Progress['recent']): Progress {
  const items: Progress['items'] = {};
  for (const item of ITEMS) items[item] = { learn: 0, box: 1, due: 0 };
  return { ...freshProgress(), turn: 100, items, recent };
}

const answers = (right: number, wrong: number) => [...Array<boolean>(right).fill(true), ...Array<boolean>(wrong).fill(false)];

describe('learn, then quiz', () => {
  it('shows a new item with its answer first, and asks for it with the answer hidden after the learn views', () => {
    const { cards } = play(freshProgress(), 12, () => true);
    expect(cards[0]?.kind).toBe('learn');
    const firstQuiz = cards.findIndex((card) => card.kind === 'quiz');
    expect(firstQuiz).toBeGreaterThan(0);
    expect(firstQuiz).toBeLessThanOrEqual(6);
    const quiz = cards[firstQuiz];
    if (quiz?.kind !== 'quiz') throw new Error('no quiz card');
    const views = cards.slice(0, firstQuiz).filter((card) => card.kind === 'learn' && card.item === quiz.item);
    expect(views).toHaveLength(LEARN_VIEWS);
  });

  it('plays a cell that has the value of the item', () => {
    const { cards } = play(freshProgress(), 60, () => true);
    for (const card of cards) {
      if (card.kind === 'full') continue;
      const { dimension, value } = splitItem(card.item);
      expect(toCoords(card.cell)[dimension]).toBe(value);
    }
  });

  it('brings in new items a few at a time, and all of them while the player answers right', () => {
    let progress = freshProgress();
    const random = seeded(7);
    for (let i = 0; i < 200; i++) {
      progress = play(progress, 1, () => true, random).progress;
      const unsteady = Object.values(progress.items).filter((state) => state.learn > 0 || state.box === 0);
      expect(unsteady.length).toBeLessThanOrEqual(3);
    }
    expect(Object.keys(progress.items)).toHaveLength(ITEMS.length);
  });
});

describe('Leitner boxes', () => {
  const learned = (item: ItemId) => seeLearn(seeLearn(freshProgress(), item), item);

  it('moves a right answer one box up and waits longer each time', () => {
    let progress = learned('row-2');
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      progress = answerItem(progress, 'row-2', true);
      const state = progress.items['row-2'];
      expect(state?.box).toBe(i + 1);
      waits.push((state?.due ?? 0) - progress.turn);
    }
    expect(waits[1]).toBeGreaterThan(waits[0] ?? Infinity);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? Infinity);
  });

  it('sends a wrong answer back to box 0 and keeps the item due, after one other card', () => {
    let progress = answerItem(answerItem(learned('row-2'), 'row-2', true), 'row-2', true);
    progress = { ...progress, items: { ...progress.items, 'layer-0': { learn: 0, box: 3, due: 0 } } };
    progress = answerItem(progress, 'row-2', false);
    expect(progress.items['row-2']).toMatchObject({ box: 0, due: progress.turn });
    expect(nextCard(progress, seeded())).toMatchObject({ kind: 'quiz', item: 'layer-0' });
    progress = answerItem(progress, 'layer-0', true);
    expect(nextCard(progress, seeded())).toMatchObject({ kind: 'quiz', item: 'row-2' });
  });

  it('refuses a quiz answer for an item that is still in learn', () => {
    expect(() => answerItem(seeLearn(freshProgress(), 'layer-1'), 'layer-1', true)).toThrow();
  });
});

describe('what the player hears', () => {
  it('gives the weakest dimension the most cards', () => {
    const progress = allInQuiz({ layer: answers(20, 0), row: answers(4, 16), column: answers(14, 6) });
    expect(weakest(progress)).toBe('row');
    const random = seeded(3);
    const counts = { layer: 0, row: 0, column: 0 };
    for (let i = 0; i < 2000; i++) {
      const card = nextCard(progress, random);
      if (card.kind !== 'full') counts[splitItem(card.item).dimension] += 1;
    }
    expect(counts.row).toBeGreaterThan(counts.column);
    expect(counts.column).toBeGreaterThan(counts.layer);
    expect(counts.row).toBeGreaterThan(3 * counts.layer);
  });

  it('asks for full cells only when every item is in the quiz, and more as every dimension improves', () => {
    expect(fullShare(play(freshProgress(), 20, () => true).progress)).toBe(0);
    const weak = fullShare(allInQuiz({ layer: answers(20, 0), row: answers(10, 10), column: answers(20, 0) }));
    const strong = fullShare(allInQuiz({ layer: answers(20, 0), row: answers(18, 2), column: answers(20, 0) }));
    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak);
    const random = seeded(5);
    const kinds = Array.from({ length: 500 }, () => nextCard(allInQuiz({ layer: answers(20, 0), row: answers(20, 0), column: answers(20, 0) }), random).kind);
    expect(kinds).toContain('full');
    expect(kinds).toContain('quiz');
  });

  it('counts a full card for each dimension, and sends the item of a missed part back to box 0', () => {
    const progress = allInQuiz({ layer: [], row: [], column: [] });
    const cell = 1 * 16 + 2 * 4 + 3; // layer 1, row 2, column 3
    const after = answerFull(progress, cell, { layer: 1, row: 0, column: 3 });
    expect(after.recent).toEqual({ layer: [true], row: [false], column: [true] });
    expect(after.items['row-2']).toMatchObject({ box: 0, due: after.turn });
    expect(after.items['layer-1']?.box).toBe(1);
  });

  it('keeps only the last 20 answers of a dimension', () => {
    let progress = allInQuiz({ layer: answers(20, 0), row: [], column: [] });
    progress = answerItem(progress, 'layer-0', false);
    expect(progress.recent.layer).toHaveLength(20);
    expect(progress.recent.layer.at(-1)).toBe(false);
  });
});

describe('stored progress', () => {
  it('reads back what it stores', () => {
    const { progress } = play(freshProgress(), 40, (card) => card.cell % 3 !== 0);
    expect(parseProgress(JSON.parse(JSON.stringify(progress)))).toEqual(progress);
  });

  it('starts fresh from a value that is not valid', () => {
    const good = JSON.parse(JSON.stringify(play(freshProgress(), 10, () => true).progress)) as Record<string, unknown>;
    const bad: unknown[] = [
      null,
      'text',
      [],
      { ...good, version: 2 },
      { ...good, turn: -1 },
      { ...good, items: { 'pitch-0': { learn: 0, box: 0, due: 0 } } },
      { ...good, items: { 'layer-0': { learn: 0, box: 9, due: 0 } } },
      { ...good, recent: { layer: [1], row: [], column: [] } },
      { ...good, recent: { layer: [] } },
      { ...good, last: 'row-7' },
    ];
    for (const value of bad) expect(parseProgress(value)).toEqual(freshProgress());
    expect(DIMENSIONS.every((dimension) => Array.isArray(parseProgress(good).recent[dimension]))).toBe(true);
  });
});

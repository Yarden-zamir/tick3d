import { describe, expect, it } from 'vitest';
import { NO_LIMIT } from './clock.ts';
import { type RecordSetup, addLoss, parseRecords } from './records.ts';

const setup: RecordSetup = { difficulty: 'hard', clock: NO_LIMIT, hideBoard: false, hideHistory: false };

describe('survival records', () => {
  it('sets a first record without news, then reports only a longer game', () => {
    const first = addLoss({}, setup, 12);
    expect(first.news).toBeUndefined();
    expect(addLoss(first.records, setup, 12).news).toBeUndefined();
    expect(addLoss(first.records, setup, 9).news).toBeUndefined();
    const longer = addLoss(first.records, setup, 15);
    expect(longer.news).toEqual({ moves: 15, previous: 12 });
    expect(addLoss(longer.records, setup, 14).news).toBeUndefined();
  });

  it('keeps one record per level, time limit and hide setting', () => {
    const { records } = addLoss({}, setup, 30);
    const others: RecordSetup[] = [
      { ...setup, difficulty: 'easy' },
      { ...setup, clock: { perMove: 10, perGame: null } },
      { ...setup, clock: { perMove: null, perGame: 10 * 60 } },
      { ...setup, hideBoard: true },
      { ...setup, hideHistory: true },
    ];
    for (const other of others) {
      expect(addLoss(records, other, 8).news).toBeUndefined();
      expect(Object.keys(addLoss(records, other, 8).records)).toHaveLength(2);
    }
  });

  it('keeps only valid stored counts', () => {
    expect(parseRecords({ a: 5, b: 0, c: -1, d: 2.5, e: '7', f: null })).toEqual({ a: 5 });
    expect(parseRecords(null)).toEqual({});
    expect(parseRecords([3])).toEqual({});
  });

  it('refuses a game without moves', () => {
    expect(() => addLoss({}, setup, 0)).toThrow(RangeError);
  });
});

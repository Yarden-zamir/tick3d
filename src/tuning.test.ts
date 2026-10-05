import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, TUNING_FIELDS, feelAt, isDefaultTuning, isTuning, parseTuning } from './tuning.ts';

describe('tiring', () => {
  it('stays fresh until tireFrom, is fully tired from tireTo, and moves steadily between', () => {
    const style = DEFAULT_TUNING.medium;
    expect(feelAt(style, 0)).toEqual(style.fresh);
    expect(feelAt(style, style.tireFrom)).toEqual(style.fresh);
    expect(feelAt(style, style.tireTo)).toEqual(style.tired);
    expect(feelAt(style, 64)).toEqual(style.tired);
    let last = 1;
    for (let moves = style.tireFrom; moves <= style.tireTo; moves++) {
      const { block } = feelAt(style, moves);
      expect(block).toBeLessThanOrEqual(last);
      last = block;
    }
  });

  it('jumps at tireTo when the two move counts are equal or reversed', () => {
    const style = { ...DEFAULT_TUNING.easy, tireFrom: 30, tireTo: 20 };
    expect(feelAt(style, 19)).toEqual(style.fresh);
    expect(feelAt(style, 20)).toEqual(style.tired);
  });
});

describe('stored advanced settings', () => {
  it('reads back what the fields write', () => {
    let tuning = DEFAULT_TUNING;
    for (const field of TUNING_FIELDS) tuning = field.set(tuning, field.max);
    const stored = parseTuning(JSON.parse(JSON.stringify(tuning)));
    for (const field of TUNING_FIELDS) expect(field.get(stored), field.label).toBe(field.max);
    expect(isDefaultTuning(stored)).toBe(false);
  });

  it('keeps the default for every missing, out-of-range or wrong value', () => {
    expect(parseTuning(null)).toEqual(DEFAULT_TUNING);
    expect(parseTuning({ easy: 'x', hard: { budgetMs: 999_999, branching: '3' } })).toEqual(DEFAULT_TUNING);
    expect(parseTuning({ hard: { budgetMs: 1000 } }).hard.budgetMs).toBe(1000);
    expect(isDefaultTuning(parseTuning({}))).toBe(true);
    // A stored default never moves to another value, so a saved change keeps every other default.
    expect(isDefaultTuning(parseTuning(JSON.parse(JSON.stringify(DEFAULT_TUNING))))).toBe(true);
    expect(parseTuning({ hard: { branching: 7.6 } }).hard.branching).toBe(8);
  });
});

describe('isTuning', () => {
  it('accepts full settings in range and refuses anything it would have to fix', () => {
    expect(isTuning(DEFAULT_TUNING)).toBe(true);
    expect(isTuning({ ...DEFAULT_TUNING, hard: { ...DEFAULT_TUNING.hard, budgetMs: 5000 } })).toBe(false);
    expect(isTuning({ ...DEFAULT_TUNING, easy: undefined })).toBe(false);
    expect(isTuning({ ...DEFAULT_TUNING, strongCellBonus: '3' })).toBe(false);
    expect(isTuning(null)).toBe(false);
  });
});

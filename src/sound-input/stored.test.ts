import { describe, expect, it } from 'vitest';
import { DEFAULT_STICKINESS } from './sticky.ts';
import { DEFAULT_STORED, parseStored, toStorage } from './stored.ts';

describe('stored choices', () => {
  it('reads back what it stores', () => {
    const stored = { range: { low: 210, high: 1350 }, stickiness: { share: 0.3, buildUpMs: 2500 } };
    expect(parseStored(JSON.parse(JSON.stringify(toStorage(stored))))).toEqual(stored);
    expect(parseStored(JSON.parse(JSON.stringify(toStorage(DEFAULT_STORED))))).toEqual(DEFAULT_STORED);
  });

  it('treats a missing or wrong version as nothing stored', () => {
    for (const bad of [null, 'x', 42, {}, { range: { low: 210, high: 1350 } }, { version: 2, range: { low: 210, high: 1350 } }]) {
      expect(parseStored(bad), JSON.stringify(bad)).toEqual(DEFAULT_STORED);
    }
  });

  it('gives a bad field its default and keeps the good fields', () => {
    const stickiness = { share: 0.2, buildUpMs: 800 };
    for (const range of [{ low: 1350, high: 210 }, { low: -1, high: 300 }, { low: 210, high: '1350' }, { low: 210, high: Infinity }, 'x']) {
      expect(parseStored({ version: 1, range, stickiness }), JSON.stringify(range)).toEqual({ range: null, stickiness });
    }
    for (const bad of [{ share: 2, buildUpMs: 800 }, { share: -0.1, buildUpMs: 800 }, { share: 0.2, buildUpMs: 60_000 }, { share: '0.2', buildUpMs: 800 }]) {
      const parsed = parseStored({ version: 1, range: null, stickiness: bad });
      expect(parsed.stickiness.share === DEFAULT_STICKINESS.share || parsed.stickiness.buildUpMs === DEFAULT_STICKINESS.buildUpMs, JSON.stringify(bad)).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeCode, parseSessionUpdate, parseSessionView } from './protocol.ts';

describe('normalizeCode', () => {
  it('accepts 4 characters from the alphabet in any case', () => {
    expect(normalizeCode(' ab3k ')).toBe('AB3K');
  });

  it.each(['ABC', 'ABCDE', 'AB-K', 'AB0K', 'ABOK', ''])('rejects %j', (input) => {
    expect(normalizeCode(input)).toBeUndefined();
  });
});

describe('parseSessionView', () => {
  const valid = {
    code: 'AB3K',
    name: 'Match',
    games: [[0, 1]],
    seats: { X: true, O: false },
    you: 'X',
    options: { hideBoard: true, hideHistory: false },
    locked: false,
    version: 2,
  };

  it('accepts a valid view', () => {
    expect(parseSessionView(valid)).toEqual(valid);
  });

  it.each([
    ['games', { ...valid, games: [[64]] }],
    ['you', { ...valid, you: 'Z' }],
    ['seats', { ...valid, seats: {} }],
    ['options', { ...valid, options: { hideBoard: 'yes', hideHistory: false } }],
    ['locked', { ...valid, locked: undefined }],
  ])('throws on a bad %s field', (_, input) => {
    expect(() => parseSessionView(input)).toThrow();
  });
});

describe('parseSessionUpdate', () => {
  it('accepts a name and match options', () => {
    expect(parseSessionUpdate({ name: ' Rematch ', hideBoard: true })).toEqual({ name: 'Rematch', hideBoard: true });
    expect(parseSessionUpdate({ hideHistory: false })).toEqual({ hideHistory: false });
  });

  it.each([{}, { name: '' }, { hideBoard: 'true' }, { locked: true }, null])('rejects %j', (input) => {
    expect(parseSessionUpdate(input)).toBeUndefined();
  });
});

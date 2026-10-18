import { describe, expect, it } from 'vitest';
import { parseMyCodes, parseTesterCodes } from './codes.ts';

const CODE = 'AAAAAAAAAAAAAAAAAAAAAA1';

describe('the codes that this browser keeps', () => {
  it('keeps the valid entries and drops the others', () => {
    const good = { id: 2, code: CODE, name: 'Dana', email: 'dana@example.com' };
    expect(parseMyCodes([good, { ...good, id: 0 }, { ...good, code: 'short' }, { ...good, name: '' }, { ...good, email: 'x' }, 'text', null])).toEqual([good]);
    expect(parseMyCodes('not a list')).toEqual([]);
    expect(parseMyCodes(null)).toEqual([]);
  });
});

describe('the public list', () => {
  it('refuses a free code with a name, and a Gravatar without a claim', () => {
    const free = { id: 1, hint: 'AAA', claimed: false, name: null, gravatar: null };
    expect(parseTesterCodes({ codes: [free] })).toEqual({ codes: [free] });
    expect(parseTesterCodes({ codes: [{ ...free, name: 'Tom' }] })).toBeUndefined();
    expect(parseTesterCodes({ codes: [{ ...free, gravatar: 'a'.repeat(64) }] })).toBeUndefined();
    expect(parseTesterCodes({ codes: [{ ...free, hint: CODE }] })).toBeUndefined();
  });
});

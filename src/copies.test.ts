import { describe, expect, it } from 'vitest';
import { parseAppOpen } from './copies.ts';

describe('an app open report', () => {
  it('takes a person id or null in by, and nothing else', () => {
    expect(parseAppOpen({ by: null, proof: 'token', store: 'apple' })).toEqual({ by: null, proof: 'token', store: 'apple' });
    expect(parseAppOpen({ by: '0123456789abcdef', proof: 'token', store: 'play' })).toEqual({ by: '0123456789abcdef', proof: 'token', store: 'play' });
    for (const body of [{}, { by: 'Dana' }, null]) expect(parseAppOpen(body)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { parseAppOpen } from './copies.ts';

describe('an app open report', () => {
  it('takes a person id or null in by, and nothing else', () => {
    expect(parseAppOpen({ by: null, proof: 'token' })).toEqual({ by: null, proof: 'token' });
    expect(parseAppOpen({ by: '0123456789abcdef', proof: 'token' })).toEqual({ by: '0123456789abcdef', proof: 'token' });
    for (const body of [{}, { by: 'Dana' }, null]) expect(parseAppOpen(body)).toBeUndefined();
  });
});

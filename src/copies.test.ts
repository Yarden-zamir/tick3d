import { describe, expect, it } from 'vitest';
import { parseAppOpen } from './copies.ts';

describe('an app open report', () => {
  it('takes a person id or null in by, and nothing else', () => {
    expect(parseAppOpen({ by: null })).toEqual({ by: null });
    expect(parseAppOpen({ by: '0123456789abcdef' })).toEqual({ by: '0123456789abcdef' });
    for (const body of [{}, { by: 'Dana' }, null]) expect(parseAppOpen(body)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { parseAppOpen } from './copies.ts';

const DEVICE = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';

describe('an app open report', () => {
  it('takes a person id or null in by, and an Apple device id only with an Apple proof', () => {
    expect(parseAppOpen({ by: null, proof: 'token', store: 'apple', device: DEVICE })).toEqual({ by: null, proof: 'token', store: 'apple', device: DEVICE });
    expect(parseAppOpen({ by: '0123456789abcdef', proof: 'token', store: 'play' })).toEqual({ by: '0123456789abcdef', proof: 'token', store: 'play' });
    for (const body of [
      {},
      { by: 'Dana' },
      null,
      { by: null, proof: 'token', store: 'apple' },
      { by: null, proof: 'token', store: 'apple', device: DEVICE.toUpperCase() },
      { by: null, proof: 'token', store: 'apple', device: DEVICE.replaceAll('-', '') },
      { by: null, proof: 'token', store: 'play', device: DEVICE },
    ]) {
      expect(parseAppOpen(body)).toBeUndefined();
    }
  });
});

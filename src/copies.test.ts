import { describe, expect, it } from 'vitest';
import { ACTIVATION_ASK_MS, offersActivation, parseAppOpen } from './copies.ts';
import { toEpochMs as ms } from './epoch.ts';

describe('the activation popup', () => {
  const ready = { inApp: true, loggedIn: true, copy: 'device', askedAt: null, now: ms(10 * ACTIVATION_ASK_MS) } as const;

  it('shows in the app, logged in, for a copy of this device that nobody activated', () => {
    expect(offersActivation(ready)).toBe(true);
  });

  it.each([
    ['in a browser', { inApp: false }],
    ['without a login', { loggedIn: false }],
    ['when the account holds a copy', { copy: 'activated' }],
    ['without a copy on this device, or with a copy of another account', { copy: 'none' }],
    ['less than a day after Not now', { askedAt: ms(10 * ACTIVATION_ASK_MS - 1000) }],
  ] as const)('stays hidden %s', (_, change) => {
    expect(offersActivation({ ...ready, ...change })).toBe(false);
  });

  it('asks again a day after Not now', () => {
    expect(offersActivation({ ...ready, askedAt: ms(9 * ACTIVATION_ASK_MS) })).toBe(true);
  });
});

describe('an app open report', () => {
  it('takes a person id or null in by, and nothing else', () => {
    expect(parseAppOpen({ by: null })).toEqual({ by: null });
    expect(parseAppOpen({ by: '0123456789abcdef' })).toEqual({ by: '0123456789abcdef' });
    for (const body of [{}, { by: 'Dana' }, null]) expect(parseAppOpen(body)).toBeUndefined();
  });
});

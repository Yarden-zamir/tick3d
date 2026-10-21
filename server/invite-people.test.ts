import { describe, expect, it } from 'vitest';
import { toEpochMs as ms } from '../src/epoch.ts';
import { peopleOf } from './invite-people.ts';

describe('the people of an inviter', () => {
  it('merges events that share a device or an owner, also through a chain', () => {
    const times = peopleOf([
      { keys: ['t:phone', 'o:phone', 'e:dana@example.com'], at: ms(30) },
      // The same phone after a login: the app open shares the device token.
      { keys: ['t:phone', 'o:account-a'], at: ms(40) },
      // Another device of that account.
      { keys: ['t:laptop', 'o:account-a'], at: ms(20) },
      // Somebody else.
      { keys: ['t:other', 'o:other'], at: ms(50) },
    ]);
    expect(times.toSorted((a, b) => a - b)).toEqual([ms(20), ms(50)]);
  });

  it('counts nothing without events', () => {
    expect(peopleOf([])).toEqual([]);
  });
});

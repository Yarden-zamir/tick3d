import { describe, expect, it } from 'vitest';
import type { PersonId } from '../protocol.ts';
import { inviteUrl, inviterOf } from './invite.ts';

const DANA = '0123456789abcdef' as PersonId;
const TOM = 'fedcba9876543210' as PersonId;

describe('the invite link', () => {
  it('names the sharer on the short address in production, and on /testing elsewhere', () => {
    expect(inviteUrl({ hostname: 'tick3d.yarden-zamir.com', origin: 'https://tick3d.yarden-zamir.com' }, DANA)).toBe(`https://testing.tick3d.yarden-zamir.com/?by=${DANA}`);
    expect(inviteUrl({ hostname: 'pr-7.tick3d.yarden-zamir.com', origin: 'https://pr-7.tick3d.yarden-zamir.com' }, DANA)).toBe(`https://pr-7.tick3d.yarden-zamir.com/testing?by=${DANA}`);
  });

  it('has no by before the page knows the person', () => {
    expect(inviteUrl({ hostname: 'localhost', origin: 'http://localhost:5180' }, null)).toBe('http://localhost:5180/testing');
  });
});

describe('the inviter of a browser', () => {
  it('keeps the first inviter over a later link', () => {
    expect(inviterOf(DANA, `?by=${TOM}`)).toBe(DANA);
    expect(inviterOf(null, `?by=${TOM}`)).toBe(TOM);
    expect(inviterOf(DANA, '')).toBe(DANA);
  });

  it.each([['?by=nope'], ['?by='], [''], [`?by=${DANA.toUpperCase()}`]])('ignores a bad or missing by: %s', (search) => {
    expect(inviterOf(null, search)).toBeNull();
    // A broken stored value counts as none.
    expect(inviterOf({ by: DANA }, search)).toBeNull();
  });
});

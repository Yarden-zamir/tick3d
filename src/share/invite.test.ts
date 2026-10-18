import { describe, expect, it } from 'vitest';
import type { PersonId } from '../protocol.ts';
import { inviteUrl, inviterOf } from './invite.ts';

const DANA = '0123456789abcdef' as PersonId;
const TOM = 'fedcba9876543210' as PersonId;

describe('the invite link', () => {
  it('names the sharer by person id on the /share page of the host', () => {
    expect(inviteUrl('https://tick3d.yarden-zamir.com', DANA)).toBe(`https://tick3d.yarden-zamir.com/share?by=${DANA}`);
    expect(inviteUrl('https://pr-7.tick3d.yarden-zamir.com', DANA)).toBe(`https://pr-7.tick3d.yarden-zamir.com/share?by=${DANA}`);
  });

  it('has no by before the page knows the person', () => {
    expect(inviteUrl('http://localhost:5180', null)).toBe('http://localhost:5180/share');
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

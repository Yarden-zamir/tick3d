import { describe, expect, it } from 'vitest';
import { knownVersion, versionOf } from './version.ts';

describe('the page of /share', () => {
  it('waits for the server on a first visit', () => {
    expect(knownVersion('', false)).toBeUndefined();
    expect(knownVersion('?by=0123456789abcdef', false)).toBeUndefined();
  });

  it('shows the page for everyone once the app is live, and the closed-test page otherwise', () => {
    expect(versionOf('live')).toBe('general');
    expect(versionOf('testing')).toBe('testing');
    expect(versionOf(undefined)).toBe('testing');
  });

  it('keeps the page for everyone in a browser that saw the app live', () => {
    expect(knownVersion('', true)).toBe('general');
  });

  it('opens the page that the query names, for a review', () => {
    expect(knownVersion('?version=general', false)).toBe('general');
    expect(knownVersion('?version=testing&by=0123456789abcdef', true)).toBe('testing');
    expect(knownVersion('?version=other', false)).toBeUndefined();
  });
});

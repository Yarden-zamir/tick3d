// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, storedMe } from './online.ts';
import { STORAGE_KEYS } from './storage-keys.ts';

describe('the remembered account', () => {
  const me = { loginAvailable: true, user: null, name: 'Dana', googleLogin: true, googleOneTapClient: null, githubLogin: null, googleConnected: false, person: '0123456789abcdef', hasCopy: false };

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('keeps the last answer of /api/me, so the next visit shows the account at once', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(me), { headers: { 'content-type': 'application/json' } }));
    expect(storedMe()).toBeNull();
    await api.me();
    expect(storedMe()).toEqual(me);
  });

  it('counts a stored answer that does not parse as none', () => {
    localStorage.setItem(STORAGE_KEYS.account, JSON.stringify({ ...me, googleConnected: 'yes' }));
    expect(storedMe()).toBeNull();
    localStorage.setItem(STORAGE_KEYS.account, '{');
    expect(storedMe()).toBeNull();
  });
});

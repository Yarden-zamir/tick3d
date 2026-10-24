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

  it('forgets the account at a logout, also an answer that was on its way', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/me')) return new Promise<Response>((resolve) => (answer = resolve));
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const pending = api.me();
    await Promise.resolve();
    await api.logout();
    answer(new Response(JSON.stringify(me), { headers: { 'content-type': 'application/json' } }));
    // The older answer comes back as null, so the page keeps the logged-out state.
    expect(await pending).toBeNull();
    expect(storedMe()).toBeNull();
  });

  it('keeps the One Tap account when an older answer of /api/me comes after it', async () => {
    const signedIn = { ...me, user: { provider: 'google', login: 'Dana Levi', avatar: null, name: null, seed: null }, googleConnected: true };
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/me')) return new Promise<Response>((resolve) => (answer = resolve));
      return new Response(JSON.stringify(signedIn), { headers: { 'content-type': 'application/json' } });
    });
    const pending = api.me();
    await Promise.resolve();
    await api.googleOneTap('credential');
    answer(new Response(JSON.stringify(me), { headers: { 'content-type': 'application/json' } }));
    expect(await pending).toBeNull();
    expect(storedMe()).toEqual(signedIn);
  });

  it('keeps the account forgotten when a rename answers after a deletion', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/me/name')) return new Promise<Response>((resolve) => (answer = resolve));
      expect(init?.method).toBe('DELETE');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const pending = api.setName('Dana');
    await Promise.resolve();
    await api.deleteData();
    answer(new Response(JSON.stringify(me), { headers: { 'content-type': 'application/json' } }));
    await pending;
    expect(storedMe()).toBeNull();
  });

  it('counts a stored answer that does not parse as none', () => {
    localStorage.setItem(STORAGE_KEYS.account, JSON.stringify({ ...me, googleConnected: 'yes' }));
    expect(storedMe()).toBeNull();
    localStorage.setItem(STORAGE_KEYS.account, '{');
    expect(storedMe()).toBeNull();
  });
});

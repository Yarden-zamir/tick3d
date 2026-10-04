import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, authConfigFromEnv, createAuth } from './auth.ts';

const config: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  secret: 'x'.repeat(40),
  origin: 'https://tick3d.example.com',
  cookieDomain: 'tick3d.example.com',
};

const request = (cookies: Record<string, string> = {}) =>
  ({ headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } }) as unknown as IncomingMessage;

function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? '';
}

// A fake GitHub: answers the code exchange and the profile request.
function fakeGitHub(profile: object = { id: 7, login: 'octo', avatar_url: 'https://avatars.githubusercontent.com/u/7?v=4' }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const body = String(url).includes('access_token') ? { access_token: 'gho_test' } : profile;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

async function login(returnTo = 'https://pr.5.tick3d.example.com/?code=ABCD', profile?: object) {
  const github = fakeGitHub(profile);
  const auth = createAuth(config, github.impl, () => 1_000);
  const start = auth.start(config.origin, returnTo);
  const state = new URL(start.location).searchParams.get('state');
  const nonce = cookieValue(start.cookies[0] ?? '');
  const done = await auth.finish(request({ t3_oauth: nonce }), 'the-code', state);
  return { auth, done, github, start };
}

describe('GitHub login', () => {
  it('sends a preview to the login origin first', () => {
    const auth = createAuth(config, fakeGitHub().impl);
    const { location } = auth.start('https://pr.5.tick3d.example.com', 'https://pr.5.tick3d.example.com/');
    expect(location).toBe('https://tick3d.example.com/api/auth/login?return=https%3A%2F%2Fpr.5.tick3d.example.com%2F');
  });

  it('logs in, sets a cookie for the whole domain, and returns to the page', async () => {
    const { auth, done, github } = await login();
    expect(done.user).toEqual({ id: 7, login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' });
    expect(done.location).toBe('https://pr.5.tick3d.example.com/?code=ABCD');
    const account = done.cookies.find((c) => c.startsWith('t3_user='));
    expect(account).toContain('Domain=tick3d.example.com');
    expect(account).toContain('HttpOnly');
    expect(github.calls).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
    expect(auth.user(request({ t3_user: cookieValue(account ?? '') }))?.login).toBe('octo');
  });

  it('never returns to a foreign site', async () => {
    const { done } = await login('https://evil.example.org/');
    expect(done.location).toBe('https://tick3d.example.com/');
  });

  it('refuses a login without the matching state cookie', async () => {
    const auth = createAuth(config, fakeGitHub().impl, () => 1_000);
    const state = new URL(auth.start(config.origin, null).location).searchParams.get('state');
    await expect(auth.finish(request({ t3_oauth: 'someone-else' }), 'code', state)).rejects.toThrow();
  });

  it('refuses a changed or expired account cookie', async () => {
    const { done } = await login();
    const value = cookieValue(done.cookies.find((c) => c.startsWith('t3_user=')) ?? '');
    const later = createAuth(config, fakeGitHub().impl, () => 1_000 + 91 * 86_400_000);
    expect(later.user(request({ t3_user: value }))).toBeUndefined();
    const auth = createAuth(config, fakeGitHub().impl, () => 1_000);
    expect(auth.user(request({ t3_user: `${value.slice(0, -2)}AA` }))).toBeUndefined();
    const other = createAuth({ ...config, secret: 'y'.repeat(40) }, fakeGitHub().impl, () => 1_000);
    expect(other.user(request({ t3_user: value }))).toBeUndefined();
  });

  it('refuses a profile with an avatar from outside GitHub', async () => {
    await expect(login(undefined, { id: 7, login: 'octo', avatar_url: 'https://evil.example.org/a.png' })).rejects.toThrow();
  });
});

describe('login settings', () => {
  it('turns login off without settings, and stops on half the settings', () => {
    expect(authConfigFromEnv({})).toBeUndefined();
    expect(authConfigFromEnv({ AUTH_ORIGIN: 'https://x', COOKIE_DOMAIN: 'x' })).toBeUndefined();
    expect(() => authConfigFromEnv({ GITHUB_CLIENT_ID: 'x' })).toThrow();
    expect(() =>
      authConfigFromEnv({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b', AUTH_SECRET: 'short', AUTH_ORIGIN: 'https://x', COOKIE_DOMAIN: 'x' }),
    ).toThrow();
  });
});

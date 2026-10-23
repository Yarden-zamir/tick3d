import { createSign, generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PRACTICE_RUNS_PER_10_MINUTES } from './api-docs.ts';
import { type AuthConfig, TooManyRequests, authConfigFromEnv, clientOf, createAuth, createLimiter } from './auth.ts';

const config: AuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  secret: 'x'.repeat(40),
  origin: 'https://tick3d.example.com',
  cookieDomain: 'tick3d.example.com',
  google: undefined,
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
    calls.push(url);
    const body = url.includes('access_token') ? { access_token: 'gho_test' } : profile;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

async function login(returnTo = 'https://pr-5.tick3d.example.com/?code=ABCD', profile?: object) {
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
    const { location } = auth.start('https://pr-5.tick3d.example.com', 'https://pr-5.tick3d.example.com/');
    expect(location).toBe('https://tick3d.example.com/api/auth/login?return=https%3A%2F%2Fpr-5.tick3d.example.com%2F');
  });

  it('logs in, sets a cookie for the whole domain, and returns to the page', async () => {
    const { auth, done, github } = await login();
    expect(done.user).toEqual({ id: 7, login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' });
    expect(done.location).toBe('https://pr-5.tick3d.example.com/?code=ABCD');
    const account = done.cookies.find((c) => c.startsWith('t3_user='));
    expect(account).toContain('Domain=tick3d.example.com');
    expect(account).toContain('HttpOnly');
    expect(github.calls).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
    expect(auth.user(request({ t3_user: cookieValue(account ?? '') }))).toMatchObject({ id: 7, login: 'octo' });
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

// A fake Google: signs ID tokens with its own key, answers the code exchange and publishes the key.
const GOOGLE_CLIENT = 'google-client.apps.googleusercontent.com';
const googleConfig: AuthConfig = { ...config, google: { clientId: GOOGLE_CLIENT, clientSecret: 'google-secret' } };
const googleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_000_000;

function idToken(claims: Record<string, unknown> = {}, key = googleKey.privateKey, kid = 'key-1'): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: '1234567890', exp: NOW / 1000 + 3600, ...claims })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}

function fakeGoogle(token = idToken()) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const jwk = { ...googleKey.publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
    const body = url.includes('certs') ? { keys: [jwk] } : { id_token: token };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('Google login', () => {
  const googleOf = (auth: ReturnType<typeof createAuth>) => {
    if (auth.google === undefined) throw new Error('Google login is off');
    return auth.google;
  };

  it('is off without a Google client', () => {
    expect(createAuth(config, fakeGoogle().impl).google).toBeUndefined();
  });

  it('logs in through the login origin, asks for the profile, and keeps only the subject id in the cookie', async () => {
    const google = fakeGoogle(idToken({ name: 'Dana Levi', picture: 'https://lh3.googleusercontent.com/a/dana=s96-c' }));
    const auth = createAuth(googleConfig, google.impl, () => NOW);
    expect(googleOf(auth).start('https://pr-5.tick3d.example.com', null).location).toBe(
      'https://tick3d.example.com/api/auth/google/login?return=https%3A%2F%2Ftick3d.example.com%2F',
    );
    const start = googleOf(auth).start(config.origin, 'https://pr-5.tick3d.example.com/');
    const url = new URL(start.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tick3d.example.com/api/auth/google/callback');
    const nonce = cookieValue(start.cookies[0] ?? '');
    const done = await googleOf(auth).finish(request({ t3_oauth: nonce }), 'the-code', url.searchParams.get('state'));
    // The photo loses its size: the page adds the size that it shows.
    const profile = { name: 'Dana Levi', picture: 'https://lh3.googleusercontent.com/a/dana' };
    expect(done).toEqual({ user: { google: '1234567890', profile }, location: 'https://pr-5.tick3d.example.com/' });
    const account = auth.googleCookies(done.user).find((c) => c.startsWith('t3_user='));
    expect(account).toContain('Domain=tick3d.example.com');
    expect(auth.user(request({ t3_user: cookieValue(account ?? '') }))).toEqual({ google: '1234567890' });
  });

  it('refuses a Google login without the matching state cookie', async () => {
    const auth = createAuth(googleConfig, fakeGoogle().impl, () => NOW);
    const state = new URL(googleOf(auth).start(config.origin, null).location).searchParams.get('state');
    await expect(googleOf(auth).finish(request({ t3_oauth: 'someone-else' }), 'code', state)).rejects.toThrow();
  });

  it('accepts a One Tap token that Google signed for this client', async () => {
    const auth = createAuth(googleConfig, fakeGoogle().impl, () => NOW);
    await expect(googleOf(auth).oneTap(idToken())).resolves.toEqual({ google: '1234567890', profile: { name: null, picture: null } });
  });

  it('takes the first name when the full name does not pass as a name, and refuses a photo from elsewhere', async () => {
    const auth = createAuth(googleConfig, fakeGoogle().impl, () => NOW);
    const token = idToken({ name: 'Dana <Levi>', given_name: 'Dana', picture: 'https://evil.example.org/a.png' });
    await expect(googleOf(auth).oneTap(token)).resolves.toMatchObject({ profile: { name: 'Dana', picture: null } });
  });

  it.each([
    ['another client', idToken({ aud: 'other.apps.googleusercontent.com' })],
    ['another issuer', idToken({ iss: 'https://evil.example.org' })],
    ['an expired token', idToken({ exp: NOW / 1000 - 1 })],
    ['no subject', idToken({ sub: '' })],
    ['another key', idToken({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
    ['an unknown key id', idToken({}, googleKey.privateKey, 'key-2')],
    ['no JWT', 'not-a-token'],
    ['no string', 42],
  ])('refuses a One Tap token with %s', async (_, token) => {
    const auth = createAuth(googleConfig, fakeGoogle().impl, () => NOW);
    await expect(googleOf(auth).oneTap(token)).rejects.toThrow();
  });

  it('offers One Tap only on the login origin', () => {
    const auth = createAuth(googleConfig, fakeGoogle().impl);
    expect(googleOf(auth).oneTapClient(config.origin)).toBe(GOOGLE_CLIENT);
    expect(googleOf(auth).oneTapClient('https://pr-5.tick3d.example.com')).toBeNull();
  });

  it('reads the Google keys once, and again for an unknown key at most once a minute', async () => {
    let now = NOW;
    const google = fakeGoogle();
    const auth = createAuth(googleConfig, google.impl, () => now);
    await googleOf(auth).oneTap(idToken());
    await googleOf(auth).oneTap(idToken());
    await expect(googleOf(auth).oneTap(idToken({}, googleKey.privateKey, 'key-2'))).rejects.toThrow();
    expect(google.calls).toHaveLength(1);
    now += 61_000;
    await expect(googleOf(auth).oneTap(idToken({ exp: now / 1000 + 60 }, googleKey.privateKey, 'key-2'))).rejects.toThrow();
    expect(google.calls).toHaveLength(2);
  });
});

describe('login settings', () => {
  it('turns Google login on with both Google settings, and stops on one of them', () => {
    const github = { GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b', AUTH_SECRET: 'x'.repeat(32), AUTH_ORIGIN: 'https://x', COOKIE_DOMAIN: 'x' };
    expect(authConfigFromEnv(github)?.google).toBeUndefined();
    expect(authConfigFromEnv({ ...github, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' })?.google).toEqual({ clientId: 'g', clientSecret: 's' });
    expect(() => authConfigFromEnv({ ...github, GOOGLE_CLIENT_ID: 'g' })).toThrow();
  });

  it('turns login off without settings, and stops on half the settings', () => {
    expect(authConfigFromEnv({})).toBeUndefined();
    expect(authConfigFromEnv({ AUTH_ORIGIN: 'https://x', COOKIE_DOMAIN: 'x' })).toBeUndefined();
    expect(() => authConfigFromEnv({ GITHUB_CLIENT_ID: 'x' })).toThrow();
    expect(() =>
      authConfigFromEnv({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b', AUTH_SECRET: 'short', AUTH_ORIGIN: 'https://x', COOKIE_DOMAIN: 'x' }),
    ).toThrow();
  });
});

describe('request limits', () => {
  const from = (headers: Record<string, string>, remoteAddress = '10.0.0.9') =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('takes the client address from the last X-Forwarded-For entry, else from the socket', () => {
    expect(clientOf(from({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientOf(from({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientOf(from({}))).toBe('10.0.0.9');
  });

  // The answer of one call: allowed, or refused with the Retry-After header in whole seconds.
  const answer = (allow: (client: string, now: number) => void, client: string, now: number): string => {
    try {
      allow(client, now);
      return 'ok';
    } catch (error) {
      if (!(error instanceof TooManyRequests)) throw error;
      expect(error.status).toBe(429);
      expect(error.message).toBe('slow down');
      return error.headers['retry-after'] ?? 'no header';
    }
  };

  it('allows a client the limit per window, and again after the window', () => {
    const allow = createLimiter(2, 1_000, 10, 'slow down');
    expect([answer(allow, 'a', 0), answer(allow, 'a', 1), answer(allow, 'a', 2)]).toEqual(['ok', 'ok', '1']);
    expect(answer(allow, 'b', 2)).toBe('ok');
    expect(answer(allow, 'a', 1_000)).toBe('ok');
  });

  it('says in whole seconds, rounded up, when the window of a refused client ends', () => {
    const allow = createLimiter(1, 600_000, 10, 'slow down');
    allow('a', 100);
    expect(answer(allow, 'a', 1_000)).toBe('600');
    expect(answer(allow, 'a', 599_950)).toBe('1');
    expect(answer(allow, 'a', 600_100)).toBe('ok');
  });

  it('refuses the practice run after the documented limit', () => {
    const allow = createLimiter(PRACTICE_RUNS_PER_10_MINUTES, 600_000, 10, 'slow down');
    for (let run = 0; run < PRACTICE_RUNS_PER_10_MINUTES; run++) expect(answer(allow, 'a', run)).toBe('ok');
    expect(answer(allow, 'a', PRACTICE_RUNS_PER_10_MINUTES)).toBe('600');
  });

  it('keeps a bounded number of clients and forgets the oldest first', () => {
    const allow = createLimiter(1, 1_000, 2, 'slow down');
    answer(allow, 'a', 0);
    answer(allow, 'b', 1);
    expect(answer(allow, 'b', 2)).toBe('1');
    answer(allow, 'c', 3);
    expect(answer(allow, 'a', 4)).toBe('ok');
    expect(answer(allow, 'c', 5)).toBe('1');
  });
});

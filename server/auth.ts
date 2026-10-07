// GitHub login. Login is optional: a player plays with a browser token either way. A login links
// that token to a GitHub account, so sessions and stats follow the player across devices.
//
// The login runs on one origin (AUTH_ORIGIN), because GitHub returns to one fixed callback address.
// The account cookie is set for COOKIE_DOMAIN and its subdomains, so pull request previews see it.
// Every environment that shares AUTH_SECRET can check the cookie. Without the GitHub settings,
// login is off and the page hides it: a local or LAN host runs without any secret.
import { isRecord } from '../src/guards.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type PlayerInfo, parsePlayerInfo } from '../src/protocol.ts';
import type { GitHubUser } from './store.ts';

const USER_COOKIE = 't3_user';
const STATE_COOKIE = 't3_oauth';
const USER_DAYS = 90;
const STATE_MINUTES = 10;

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  secret: string;
  // https://tick3d.yarden-zamir.com: the origin that GitHub returns to.
  origin: string;
  // tick3d.yarden-zamir.com: the cookie is valid here and on every subdomain.
  cookieDomain: string;
};

export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_SECRET, AUTH_ORIGIN, COOKIE_DOMAIN } = env;
  // The three secrets switch login on. The origin and cookie domain are plain settings that a deploy
  // always sets, so they alone do not turn login on.
  const secrets = [GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_SECRET];
  if (secrets.every((value) => !value)) return undefined;
  // Some but not all settings is a deploy mistake, so it stops the server instead of silently disabling login.
  if (![...secrets, AUTH_ORIGIN, COOKIE_DOMAIN].every((value) => value)) {
    throw new Error('GitHub login needs all of GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_SECRET, AUTH_ORIGIN and COOKIE_DOMAIN');
  }
  if ((AUTH_SECRET ?? '').length < 32) throw new Error('AUTH_SECRET needs at least 32 characters');
  return {
    clientId: GITHUB_CLIENT_ID ?? '',
    clientSecret: GITHUB_CLIENT_SECRET ?? '',
    secret: AUTH_SECRET ?? '',
    origin: AUTH_ORIGIN ?? '',
    cookieDomain: COOKIE_DOMAIN ?? '',
  };
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

function sign(config: AuthConfig, payload: object): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(createHmac('sha256', config.secret).update(body).digest())}`;
}

// Returns the payload of a value that this server signed and that has not expired.
function verify(config: AuthConfig, value: string | undefined, now: number): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const [body, signature, ...rest] = value.split('.');
  if (body === undefined || signature === undefined || rest.length > 0) return undefined;
  const expected = createHmac('sha256', config.secret).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  return typeof payload.exp === 'number' && payload.exp > now ? payload : undefined;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function cookie(name: string, value: string, options: { maxAge: number; domain?: string; path: string }): string {
  const domain = options.domain === undefined ? '' : `; Domain=${options.domain}`;
  return `${name}=${value}; Path=${options.path}${domain}; Max-Age=${options.maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

// A return address must be on our own domain, so the login can never send a player elsewhere.
function safeReturn(config: AuthConfig, value: string | null): string {
  const home = new URL('/', config.origin).toString();
  if (value === null) return home;
  try {
    const url = new URL(value);
    const host = url.hostname;
    const ours = host === config.cookieDomain || host.endsWith(`.${config.cookieDomain}`);
    return url.protocol === 'https:' && ours ? url.toString() : home;
  } catch {
    return home;
  }
}

export type Redirect = { location: string; cookies: string[] };

export function createAuth(config: AuthConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const callbackUrl = `${config.origin}/api/auth/github/callback`;

  return {
    // The account behind this request, if it carries a valid account cookie.
    user(req: IncomingMessage): (GitHubUser & PlayerInfo) | undefined {
      const payload = verify(config, readCookie(req, USER_COOKIE), now());
      if (payload === undefined || typeof payload.id !== 'number') return undefined;
      const info = parsePlayerInfo(payload);
      return info === undefined ? undefined : { ...info, id: payload.id };
    },

    // Starts a login. A preview sends the player to the login origin first.
    start(requestOrigin: string, returnTo: string | null): Redirect {
      if (requestOrigin !== config.origin) {
        const url = new URL('/api/auth/login', config.origin);
        url.searchParams.set('return', safeReturn(config, returnTo));
        return { location: url.toString(), cookies: [] };
      }
      const nonce = randomBytes(16).toString('base64url');
      const state = sign(config, { nonce, return: safeReturn(config, returnTo), exp: now() + STATE_MINUTES * 60_000 });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('state', state);
      // No scope: the public profile (id, login, avatar) is all the game uses.
      url.searchParams.set('scope', '');
      return {
        location: url.toString(),
        cookies: [cookie(STATE_COOKIE, nonce, { maxAge: STATE_MINUTES * 60, path: '/api/auth' })],
      };
    },

    // Finishes a login: checks the state, asks GitHub who the player is, and sets the account cookie.
    async finish(req: IncomingMessage, code: string | null, state: string | null): Promise<Redirect & { user: GitHubUser }> {
      const payload = verify(config, state ?? undefined, now());
      const nonce = readCookie(req, STATE_COOKIE);
      if (payload === undefined || nonce === undefined || payload.nonce !== nonce || typeof payload.return !== 'string') {
        throw new Error('the login state is invalid or expired');
      }
      if (code === null) throw new Error('GitHub sent no code');
      const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl }),
      });
      const tokenBody: unknown = await tokenResponse.json();
      const accessToken =
        typeof tokenBody === 'object' && tokenBody !== null && 'access_token' in tokenBody ? tokenBody.access_token : undefined;
      if (typeof accessToken !== 'string') throw new Error('GitHub refused the login code');
      const userResponse = await fetchImpl('https://api.github.com/user', {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'tick3d' },
      });
      const body: unknown = await userResponse.json();
      const fields = isRecord(body) ? body : {};
      const info = parsePlayerInfo({ login: fields.login, avatar: fields.avatar_url });
      if (typeof fields.id !== 'number' || info === undefined) throw new Error('GitHub sent an unexpected profile');
      const user: GitHubUser = { id: fields.id, login: info.login, avatar: info.avatar };
      const account = sign(config, { ...user, exp: now() + USER_DAYS * 86_400_000 });
      return {
        user,
        location: payload.return,
        cookies: [
          cookie(USER_COOKIE, account, { maxAge: USER_DAYS * 86_400, domain: config.cookieDomain, path: '/' }),
          cookie(STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' }),
        ],
      };
    },

    logoutCookie(): string {
      return cookie(USER_COOKIE, '', { maxAge: 0, domain: config.cookieDomain, path: '/' });
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

// ---- Request limits ----

// The address of the client. Caddy writes the client address as the last X-Forwarded-For entry.
// Without that header, the client connects directly, for example in local development.
export function clientOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').at(-1)?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}

// A refused request: the server answers 429 with Retry-After in whole seconds.
export class TooManyRequests extends Error {
  readonly status = 429;
  readonly headers: Record<string, string>;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.headers = { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
  }
}

// Allows each client `limit` actions per window, and throws TooManyRequests for more until the window ends.
// It returns nothing, so a caller cannot test the answer by mistake instead of the refusal.
// It keeps at most `maxClients` windows: when full, it forgets the client with the oldest window.
export function createLimiter(limit: number, windowMs: number, maxClients: number, message: string) {
  if (!(limit >= 1 && windowMs > 0 && maxClients >= 1)) throw new RangeError('a limiter needs positive settings');
  const windows = new Map<string, { count: number; endsAt: number }>();
  return (client: string, now: number): void => {
    let window = windows.get(client);
    if (window === undefined || window.endsAt <= now) {
      // Delete first, so the new window goes to the end of the map's insertion order.
      windows.delete(client);
      const oldest = windows.size >= maxClients ? windows.keys().next().value : undefined;
      if (oldest !== undefined) windows.delete(oldest);
      window = { count: 0, endsAt: now + windowMs };
      windows.set(client, window);
    }
    window.count++;
    if (window.count > limit) throw new TooManyRequests(message, window.endsAt - now);
  };
}

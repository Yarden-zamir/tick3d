// GitHub and Google login. Login is optional: a player plays with a browser token either way. A login
// links that token to an account, so sessions and stats follow the player across devices.
//
// The login runs on one origin (AUTH_ORIGIN), because GitHub and Google return to one fixed callback address.
// The account cookie is set for COOKIE_DOMAIN and its subdomains, so pull request previews see it.
// Every environment that shares AUTH_SECRET can check the cookie. Without the GitHub settings,
// login is off and the page hides it: a local or LAN host runs without any secret.
// Google login is an addition to GitHub login: it needs the GitHub settings too.
import { isRecord } from '../src/guards.ts';
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type PlayerInfo, parsePlayerInfo } from '../src/protocol.ts';
import type { GitHubUser, GoogleUser } from './store.ts';

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
  // The web client of Google sign-in. Undefined when Google login is off.
  google: { clientId: string; clientSecret: string } | undefined;
};

// The account of an account cookie: GitHub or Google.
export type Login = (GitHubUser & PlayerInfo) | GoogleUser;

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
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (Boolean(GOOGLE_CLIENT_ID) !== Boolean(GOOGLE_CLIENT_SECRET)) {
    throw new Error('Google login needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
  return {
    clientId: GITHUB_CLIENT_ID ?? '',
    clientSecret: GITHUB_CLIENT_SECRET ?? '',
    secret: AUTH_SECRET ?? '',
    origin: AUTH_ORIGIN ?? '',
    cookieDomain: COOKIE_DOMAIN ?? '',
    google: GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } : undefined,
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

// Google's sign-in addresses (OpenID Connect discovery: https://accounts.google.com/.well-known/openid-configuration).
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
// Google rotates its signing keys about weekly and publishes the next one early, so an hour is safe.
const GOOGLE_KEYS_MS = 3_600_000;
// A token with an unknown key fetches the keys again, at most once in this time.
const GOOGLE_KEYS_RETRY_MS = 60_000;

export function createAuth(config: AuthConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const callbackUrl = `${config.origin}/api/auth/github/callback`;
  const googleCallbackUrl = `${config.origin}/api/auth/google/callback`;

  // A preview sends the player to the same login path on the login origin first.
  function viaLoginOrigin(path: string, returnTo: string | null): Redirect {
    const url = new URL(path, config.origin);
    url.searchParams.set('return', safeReturn(config, returnTo));
    return { location: url.toString(), cookies: [] };
  }

  // The signed state of a login and its nonce cookie. The cookie proves that this browser started the login.
  function newState(returnTo: string | null): { state: string; cookie: string } {
    const nonce = randomBytes(16).toString('base64url');
    const state = sign(config, { nonce, return: safeReturn(config, returnTo), exp: now() + STATE_MINUTES * 60_000 });
    return { state, cookie: cookie(STATE_COOKIE, nonce, { maxAge: STATE_MINUTES * 60, path: '/api/auth' }) };
  }

  // The return address of a login that this browser started, or an error.
  function checkState(req: IncomingMessage, state: string | null): string {
    const payload = verify(config, state ?? undefined, now());
    const nonce = readCookie(req, STATE_COOKIE);
    if (payload === undefined || nonce === undefined || payload.nonce !== nonce || typeof payload.return !== 'string') {
      throw new Error('the login state is invalid or expired');
    }
    return payload.return;
  }

  const accountCookie = (payload: GitHubUser | GoogleUser) =>
    cookie(USER_COOKIE, sign(config, { ...payload, exp: now() + USER_DAYS * 86_400_000 }), { maxAge: USER_DAYS * 86_400, domain: config.cookieDomain, path: '/' });
  const clearState = () => cookie(STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' });

  let googleKeys: { keys: Map<string, JsonWebKey>; fetchedAt: number } | undefined;
  async function googleKey(kid: string): Promise<JsonWebKey | undefined> {
    const cached = googleKeys?.keys.get(kid);
    const age = googleKeys === undefined ? Infinity : now() - googleKeys.fetchedAt;
    if (cached !== undefined && age < GOOGLE_KEYS_MS) return cached;
    if (cached === undefined && age < GOOGLE_KEYS_RETRY_MS) return undefined;
    const body: unknown = await (await fetchImpl(GOOGLE_KEYS)).json();
    const list = isRecord(body) && Array.isArray(body.keys) ? body.keys : [];
    const keys = new Map<string, JsonWebKey>();
    for (const key of list) if (isRecord(key) && typeof key.kid === 'string' && key.kty === 'RSA') keys.set(key.kid, key);
    if (keys.size === 0) throw new Error('Google sent no signing keys');
    googleKeys = { keys, fetchedAt: now() };
    return keys.get(kid);
  }

  // The Google account of an ID token: Google signed it for our client, and it has not expired.
  async function googleUserOf(idToken: unknown, clientId: string): Promise<GoogleUser> {
    if (typeof idToken !== 'string') throw new Error('Google sent no ID token');
    const [head, body, signature, ...rest] = idToken.split('.');
    if (head === undefined || body === undefined || signature === undefined || rest.length > 0) throw new Error('the ID token is not a JWT');
    const parse = (part: string): Record<string, unknown> => {
      const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      if (!isRecord(value)) throw new Error('the ID token is not a JWT');
      return value;
    };
    const header = parse(head);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('the ID token has an unknown signature');
    const jwk = await googleKey(header.kid);
    if (jwk === undefined) throw new Error('the ID token has an unknown key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verifySignature('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) {
      throw new Error('the ID token has a wrong signature');
    }
    const claims = parse(body);
    if (claims.aud !== clientId || !GOOGLE_ISSUERS.includes(String(claims.iss))) throw new Error('the ID token is for another app');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) throw new Error('the ID token expired');
    // Google documents the subject id as at most 255 ASCII characters.
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) throw new Error('the ID token has no subject');
    return { google: claims.sub };
  }

  // Google login with the server's Google client.
  const googleLogin = ({ clientId, clientSecret }: { clientId: string; clientSecret: string }) => ({
    // The client for Google One Tap on this page, or null. Google accepts One Tap only on the origins
    // of the client (Authorized JavaScript origins), so a preview gets only the login button.
    oneTapClient: (requestOrigin: string): string | null => (requestOrigin === config.origin ? clientId : null),

    // Starts a Google login. Only the openid scope: the game keeps Google's account id and nothing else.
    start(requestOrigin: string, returnTo: string | null): Redirect {
      if (requestOrigin !== config.origin) return viaLoginOrigin('/api/auth/google/login', returnTo);
      const { state, cookie: stateCookie } = newState(returnTo);
      const url = new URL(GOOGLE_AUTHORIZE);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', googleCallbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid');
      url.searchParams.set('state', state);
      return { location: url.toString(), cookies: [stateCookie] };
    },

    // Finishes a Google login: checks the state and asks Google who the player is. The caller sets
    // the account cookie, because connecting Google to a GitHub login keeps the GitHub cookie.
    async finish(req: IncomingMessage, code: string | null, state: string | null): Promise<{ user: GoogleUser; location: string }> {
      const location = checkState(req, state);
      if (code === null) throw new Error('Google sent no code');
      const response = await fetchImpl(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: googleCallbackUrl, grant_type: 'authorization_code' }),
      });
      const body: unknown = await response.json();
      return { user: await googleUserOf(isRecord(body) ? body.id_token : undefined, clientId), location };
    },

    // The account of a One Tap sign-in: the page sends the ID token that Google gave it.
    // Limit: no nonce, so a stolen ID token works until it expires (one hour). The X-Player header
    // keeps other sites out. Revisit this if a token leak becomes possible, for example through logs.
    oneTap: (credential: unknown): Promise<GoogleUser> => googleUserOf(credential, clientId),
  });

  return {
    // Undefined when Google login is off.
    google: config.google === undefined ? undefined : googleLogin(config.google),

    // The account behind this request, if it carries a valid account cookie.
    user(req: IncomingMessage): Login | undefined {
      const payload = verify(config, readCookie(req, USER_COOKIE), now());
      if (payload === undefined) return undefined;
      if (typeof payload.google === 'string') return { google: payload.google };
      if (typeof payload.id !== 'number') return undefined;
      const info = parsePlayerInfo(payload);
      return info === undefined ? undefined : { ...info, id: payload.id };
    },

    // Starts a GitHub login. A preview sends the player to the login origin first.
    start(requestOrigin: string, returnTo: string | null): Redirect {
      if (requestOrigin !== config.origin) return viaLoginOrigin('/api/auth/login', returnTo);
      const { state, cookie: stateCookie } = newState(returnTo);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('state', state);
      // No scope: the public profile (id, login, avatar) is all the game uses.
      url.searchParams.set('scope', '');
      return { location: url.toString(), cookies: [stateCookie] };
    },

    // Finishes a login: checks the state, asks GitHub who the player is, and sets the account cookie.
    async finish(req: IncomingMessage, code: string | null, state: string | null): Promise<Redirect & { user: GitHubUser }> {
      const location = checkState(req, state);
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
      return {
        user,
        location,
        cookies: [accountCookie(user), clearState()],
      };
    },

    // The cookies after a Google login: the account cookie, and the cleared login state.
    googleCookies: (user: GoogleUser): string[] => [accountCookie(user), clearState()],
    // The cookie after Google was connected to a GitHub login: the GitHub cookie stays.
    clearState,

    logoutCookie(): string {
      return cookie(USER_COOKIE, '', { maxAge: 0, domain: config.cookieDomain, path: '/' });
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

// The ID token in the body of POST /api/auth/google/one-tap, or undefined.
export const parseGoogleCredential = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.credential === 'string' ? body.credential : undefined;

// The GitHub logins that can read reports and moderate. GitHub logins ignore case.
const MAINTAINERS = ['yarden-zamir', 'tomcohendev'];
export const isMaintainer = (login: string): boolean => MAINTAINERS.includes(login.toLowerCase());

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

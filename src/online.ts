import type { TimeControl } from './clock.ts';
import {
  type Code,
  type MoveRequest,
  type MyGames,
  type PlayerInfo,
  type PlayerToken,
  RESULTS_PER_UPLOAD,
  type ResultUpload,
  type SessionUpdate,
  type SessionView,
  asPlayerToken,
  parsePlayerInfo,
  parseSessionView,
} from './protocol.ts';

const TOKEN_KEY = 'tick3d.player';

// crypto.randomUUID exists only on HTTPS and localhost. A phone on the local network loads the dev
// server over plain HTTP, so fall back to random hex from getRandomValues, which works everywhere.
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newToken(): PlayerToken {
  const token = asPlayerToken(randomId());
  if (token === undefined) throw new Error('randomId produced an invalid player token');
  return token;
}

// One token per browser. It survives reloads, so a player keeps the seat after a refresh.
function playerToken(): PlayerToken {
  try {
    const stored = asPlayerToken(localStorage.getItem(TOKEN_KEY));
    if (stored !== undefined) return stored;
    const created = newToken();
    localStorage.setItem(TOKEN_KEY, created);
    return created;
  } catch {
    // Storage is blocked. The seat then lasts for this page load only.
    return newToken();
  }
}

export const token = playerToken();

// A refused or failed server call. The message is fit to show to the player.
// `status` is the HTTP status of an error answer from the server. It is undefined when no usable
// answer arrived: the request did not reach the server, or a success answer had no JSON body.
export class OnlineError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const NOT_JSON = Symbol('not JSON');

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-player': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new OnlineError('Cannot reach the server. Check the connection.');
  }
  const data: unknown = await response.json().catch(() => NOT_JSON);
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Server error (${response.status}).`;
    throw new OnlineError(message, response.status);
  }
  // A proxy or a captive portal can answer 200 with an HTML page.
  if (data === NOT_JSON) throw new OnlineError('The server sent an answer that the game cannot read.');
  return data;
}

const request = async (method: string, path: string, body?: unknown): Promise<SessionView> =>
  parseSessionView(await call(method, `/sessions${path}`, body));

export type Me = { loginAvailable: boolean; user: PlayerInfo | null };

export function parseMe(value: unknown): Me {
  if (typeof value !== 'object' || value === null) throw new Error('invalid answer from /api/me');
  const { loginAvailable, user } = value as Record<string, unknown>;
  const info = user === null ? null : parsePlayerInfo(user);
  if (typeof loginAvailable !== 'boolean' || info === undefined) throw new Error('invalid answer from /api/me');
  return { loginAvailable, user: info };
}

// The page reads "My games" only to display it, so a light shape check is enough here.
export function parseMyGames(value: unknown): MyGames {
  if (typeof value !== 'object' || value === null || !('total' in value) || !('sessions' in value)) {
    throw new Error('invalid answer from /api/me/games');
  }
  return value as MyGames;
}

export const api = {
  create: (name: string, clock: TimeControl) => request('POST', '', { name, clock }),
  load: (code: Code) => request('GET', `/${code}`),
  join: (code: Code) => request('POST', `/${code}/join`),
  move: (code: Code, move: MoveRequest) => request('POST', `/${code}/moves`, move),
  newGame: (code: Code) => request('POST', `/${code}/games`),
  update: (code: Code, changes: SessionUpdate) => request('PATCH', `/${code}`, changes),
  lock: (code: Code) => request('POST', `/${code}/lock`),
  chat: (code: Code, text: string) => request('POST', `/${code}/chat`, { text }),

  me: async () => parseMe(await call('GET', '/me')),
  myGames: async () => parseMyGames(await call('GET', '/me/games')),
  logout: () => call('POST', '/auth/logout'),
  // Login is a full page visit to GitHub and back to this page.
  loginUrl: () => `/api/auth/login?return=${encodeURIComponent(location.href)}`,

  // Sends finished games in batches. Returns how many the server stored as new.
  async uploadResults(results: readonly ResultUpload[]): Promise<number> {
    let stored = 0;
    for (let start = 0; start < results.length; start += RESULTS_PER_UPLOAD) {
      const answer = await call('POST', '/results', { results: results.slice(start, start + RESULTS_PER_UPLOAD) });
      const count = typeof answer === 'object' && answer !== null && 'stored' in answer ? answer.stored : undefined;
      if (typeof count !== 'number') throw new Error('invalid answer from /api/results');
      stored += count;
    }
    return stored;
  },

  // Calls onChange after every change, and after each reconnect in case a change was missed.
  // The token marks this page's seats as present, so the other player sees "here" or "away".
  subscribe(code: Code, onChange: () => void): () => void {
    const source = new EventSource(`/api/sessions/${code}/events?player=${encodeURIComponent(token)}`);
    source.onmessage = () => onChange();
    source.onopen = () => onChange();
    return () => source.close();
  },
};

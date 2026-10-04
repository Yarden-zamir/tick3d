import type { TimeControl } from './clock.ts';
import {
  type Code,
  type MoveRequest,
  type PlayerToken,
  type SessionUpdate,
  type SessionView,
  asPlayerToken,
  parseSessionView,
} from './protocol.ts';

const TOKEN_KEY = 'tick3d.player';

function newToken(): PlayerToken {
  const token = asPlayerToken(crypto.randomUUID());
  if (token === undefined) throw new Error('crypto.randomUUID produced an invalid player token');
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

const token = playerToken();

export class OnlineError extends Error {}

async function request(method: string, path: string, body?: unknown): Promise<SessionView> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-player': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new OnlineError('Cannot reach the server. Check the connection.');
  }
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Server error (${response.status}).`;
    throw new OnlineError(message);
  }
  return parseSessionView(data);
}

export const api = {
  create: (name: string, clock: TimeControl) => request('POST', '', { name, clock }),
  load: (code: Code) => request('GET', `/${code}`),
  join: (code: Code) => request('POST', `/${code}/join`),
  move: (code: Code, move: MoveRequest) => request('POST', `/${code}/moves`, move),
  newGame: (code: Code) => request('POST', `/${code}/games`),
  update: (code: Code, changes: SessionUpdate) => request('PATCH', `/${code}`, changes),
  lock: (code: Code) => request('POST', `/${code}/lock`),

  // Calls onChange after every change, and after each reconnect in case a change was missed.
  subscribe(code: Code, onChange: () => void): () => void {
    const source = new EventSource(`/api/sessions/${code}/events`);
    source.onmessage = () => onChange();
    source.onopen = () => onChange();
    return () => source.close();
  },
};

import { hostname } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Player } from '../src/game.ts';
import {
  type Code,
  type PlayerToken,
  RESULTS_PER_UPLOAD,
  asPlayerToken,
  normalizeCode,
  parseClientEvent,
  parseGameId,
  parseMetrics,
  parseMoveRequest,
  parseNewSession,
  parseSessionUpdate,
} from '../src/protocol.ts';
import { SessionError } from '../src/session/core.ts';
import { CREATES_PER_HOUR, EVENTS_PER_10_MINUTES, WAIT_MS, matchRoute } from './api-docs.ts';
import { html, markdown, openApi } from './api-docs-render.ts';
import { type Auth, authConfigFromEnv, clientOf, createAuth, createLimiter } from './auth.ts';
import { openStore } from './store.ts';
import { createWaiters } from './waiters.ts';

const PORT = 8080;
const MAX_BODY_BYTES = 4096;
// A result upload carries up to RESULTS_PER_UPLOAD finished games of about 1 kB each.
const MAX_RESULTS_BODY_BYTES = 256 * 1024;
// An event is a short message, its kind and the app version.
const MAX_EVENT_BODY_BYTES = 1024;
// Each open page holds one event stream. This cap keeps a flood of streams from exhausting memory.
const MAX_STREAMS = 2000;
// Each long poll (GET /api/sessions/{code}?wait=) holds one request. The same reason caps them.
const MAX_WAITERS = 2000;
const waiters = createWaiters(MAX_WAITERS);
// Session codes are never freed, so one client must not use them all up: 60 new sessions per hour.
// Limit: the counts live in this process only and reset on a restart. An IPv6 client can change
// its address. Revisit this with more than one API process, a real attack, or real players that
// share one address and hit the limit (a school, for example).
const allowCreate = createLimiter(CREATES_PER_HOUR, 3_600_000, 10_000);
// Fault reports from pages: 30 per 10 minutes per address is plenty for a page that works, and
// keeps a broken or hostile page from filling the events table. Same limits as allowCreate.
const allowEvent = createLimiter(EVENTS_PER_10_MINUTES, 600_000, 10_000);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH is required');
const authConfig = authConfigFromEnv(process.env);
const auth: Auth | undefined = authConfig === undefined ? undefined : createAuth(authConfig);
// LAN_HOST=1 marks a server that a player runs on their own computer for a local network.
const lanHost = process.env.LAN_HOST === '1' ? { name: process.env.LAN_HOST_NAME || hostname() } : null;

// Event streams per session code, with the seats each one holds. They live in this process only,
// which is fine for one API container. A seat with an open stream is "present".
type Stream = { res: ServerResponse; seats: Player[] };
const streams = new Map<Code, Set<Stream>>();
let streamCount = 0;

function presenceOf(code: Code): Record<Player, boolean> {
  const present = { X: false, O: false };
  for (const stream of streams.get(code) ?? []) for (const seat of stream.seats) present[seat] = true;
  return present;
}

const store = await openStore(dbPath, { presence: presenceOf, onChange: notify });

// Tells every open page of a session to fetch it again, and wakes its long polls.
function notify(code: Code): void {
  for (const stream of streams.get(code) ?? []) stream.res.write('data: changed\n\n');
  waiters.wake(code);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, contentType: string, body: string): void {
  // The docs are public, so any site and any agent may read them.
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, cookies: string[]): void {
  res.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' });
  res.end();
}

async function readJson(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function requirePlayer(req: IncomingMessage): PlayerToken {
  const player = asPlayerToken(req.headers['x-player']);
  if (player === undefined) throw new HttpError(400, 'Missing or invalid X-Player header.');
  return player;
}

// The host Caddy terminates TLS and keeps the Host header, so every public request is https.
const originOf = (req: IncomingMessage) => `https://${req.headers.host ?? ''}`;
// The address that the docs show. A LAN host (compose.lan.yml) serves plain HTTP, and its Caddy says so.
const docsOrigin = (req: IncomingMessage) =>
  req.headers['x-forwarded-proto'] === 'http' ? `http://${req.headers.host ?? ''}` : originOf(req);

function sessionCode(value: string | undefined): Code {
  const code = normalizeCode(value ?? '');
  if (code === undefined) throw new HttpError(400, 'A code has 4 letters or digits.');
  return code;
}

// GET /api/sessions/{code}?wait=<version> holds the request until the version is greater, or WAIT_MS pass.
async function waitForChange(res: ServerResponse, code: Code, wait: string, token: PlayerToken | undefined): Promise<void> {
  const since = Number(wait);
  if (wait === '' || !Number.isInteger(since) || since < 0) throw new HttpError(400, 'wait needs a version: a whole number of 0 or more.');
  const left = new AbortController();
  // The response closes before it ends only when the client goes away.
  const onClose = () => left.abort();
  res.on('close', onClose);
  try {
    const waiting = waiters.until(code, since, async () => (await store.get(code, token)).version, left.signal, WAIT_MS);
    if (waiting === undefined) throw new HttpError(503, 'Too many requests wait now. Try again in a few seconds.');
    await waiting;
  } finally {
    res.off('close', onClose);
  }
}

// EventSource cannot send headers, so the stream takes the player token from the query string.
// Caddy keeps no access log for this site; revisit this if logging is ever turned on.
async function openStream(req: IncomingMessage, res: ServerResponse, code: Code, token: PlayerToken | undefined): Promise<void> {
  const seats = token === undefined ? [] : await store.seatsOf(code, token); // 404 before the stream opens
  // The client can leave during the await. Its close event is then already past, so no handler runs.
  if (req.destroyed || res.destroyed) return;
  if (streamCount >= MAX_STREAMS) throw new HttpError(503, 'Too many live connections. Try again later.');
  const set = streams.get(code) ?? new Set();
  const stream: Stream = { res, seats };
  req.on('close', () => {
    set.delete(stream);
    streamCount--;
    if (set.size === 0) streams.delete(code);
    if (seats.length > 0) notify(code);
  });
  streams.set(code, set);
  set.add(stream);
  streamCount++;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  // A player arriving changes what the other player sees ("away" turns into "here").
  if (seats.length > 0) notify(code);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  // Every route goes through matchRoute, so every route that the server handles has docs.
  const match = matchRoute(method, url.pathname);
  if (match === undefined) throw new HttpError(404, 'Not found.');
  if (match === 'wrong-method') throw new HttpError(405, 'Method not allowed.');
  const code = () => sessionCode(match.params.code);
  const gameId = () => {
    const id = parseGameId(match.params.id ?? '');
    if (id === undefined) throw new HttpError(400, 'A game id is 8 letters or digits, or a code and a game number.');
    return id;
  };

  switch (match.route) {
    case 'GET /api/health':
      return send(res, 200, { ok: true, lan: lanHost });
    case 'GET /api/openapi.json':
      return sendText(res, 'application/json', JSON.stringify(openApi(docsOrigin(req)), null, 2));
    case 'GET /api/docs.md':
      return sendText(res, 'text/markdown; charset=utf-8', markdown(docsOrigin(req)));
    case 'GET /api/docs':
      return sendText(res, 'text/html; charset=utf-8', html(docsOrigin(req)));

    case 'GET /api/auth/login': {
      if (auth === undefined) throw new HttpError(404, 'Login is not available on this server.');
      const { location, cookies } = auth.start(originOf(req), url.searchParams.get('return'));
      return redirect(res, location, cookies);
    }
    case 'GET /api/auth/github/callback': {
      if (auth === undefined) throw new HttpError(404, 'Login is not available on this server.');
      try {
        const { location, cookies } = await auth.finish(req, url.searchParams.get('code'), url.searchParams.get('state'));
        return redirect(res, location, cookies);
      } catch (error) {
        console.error('login failed:', error instanceof Error ? error.message : error);
        return redirect(res, '/?login=failed', []);
      }
    }
    case 'POST /api/auth/logout': {
      if (auth === undefined) throw new HttpError(404, 'Login is not available on this server.');
      // A cross-site form cannot send the X-Player header, so another site cannot log a player out.
      await store.unlinkToken(requirePlayer(req));
      return send(res, 200, { ok: true }, { 'set-cookie': auth.logoutCookie() });
    }

    case 'GET /api/me':
    case 'GET /api/me/games':
    case 'GET /api/me/history':
    case 'DELETE /api/me/history':
    case 'GET /api/me/records': {
      const token = requirePlayer(req);
      const user = auth?.user(req);
      // Every visit with a login links this browser to the account, so a new device joins at once.
      if (user !== undefined) await store.linkToken(token, user);
      if (match.route === 'GET /api/me/games') return send(res, 200, await store.myGames(token));
      // A cross-site form cannot send the X-Player header, so another site cannot clear a history.
      if (match.route === 'DELETE /api/me/history') return send(res, 200, { hidden: await store.clearHistory(token) });
      if (match.route === 'GET /api/me/history') {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'The offset is not a whole number of games.');
        return send(res, 200, await store.history(token, offset));
      }
      if (match.route === 'GET /api/me/records') return send(res, 200, { records: await store.records(token) });
      return send(res, 200, { loginAvailable: auth !== undefined, user: user === undefined ? null : { login: user.login, avatar: user.avatar } });
    }

    case 'POST /api/results': {
      const body = await readJson(req, MAX_RESULTS_BODY_BYTES);
      const results = typeof body === 'object' && body !== null && 'results' in body ? body.results : undefined;
      if (!Array.isArray(results) || results.length > RESULTS_PER_UPLOAD) {
        throw new HttpError(400, `An upload needs a results list of at most ${RESULTS_PER_UPLOAD}.`);
      }
      return send(res, 200, await store.addResults(requirePlayer(req), results));
    }

    // A read-only game link. Anybody with the id may read the game, so the answer holds no token.
    case 'GET /api/games/{id}':
      return send(res, 200, await store.game(gameId()));
    // The metrics of one player's device for a finished online game.
    case 'POST /api/games/{id}/metrics': {
      const id = gameId();
      const metrics = parseMetrics(await readJson(req));
      if (metrics === undefined) throw new HttpError(400, 'The metrics are not valid.');
      return send(res, 200, { stored: await store.addSeatMetrics(id, requirePlayer(req), metrics) });
    }
    case 'POST /api/events': {
      if (!allowEvent(clientOf(req), Date.now())) throw new HttpError(429, 'Too many reports from this address. Try again later.');
      const event = parseClientEvent(await readJson(req, MAX_EVENT_BODY_BYTES));
      if (event === undefined) throw new HttpError(400, 'An event needs a kind, a message of 1 to 300 characters and a version.');
      await store.addEvent(event);
      return send(res, 200, { ok: true });
    }
    // Aggregates only (see server/stats.ts), so the hidden stats page needs no login.
    case 'GET /api/stats':
      return send(res, 200, await store.stats());

    case 'POST /api/sessions': {
      if (!allowCreate(clientOf(req), Date.now())) throw new HttpError(429, 'Too many new games from this address. Try again later.');
      const body = parseNewSession(await readJson(req));
      if (body === undefined) throw new HttpError(400, 'A new game needs a name of 1 to 40 characters, and a valid clock or none.');
      return send(res, 201, await store.create(requirePlayer(req), body.name, body.clock));
    }
    case 'GET /api/sessions/{code}': {
      const token = asPlayerToken(req.headers['x-player']);
      const wait = url.searchParams.get('wait');
      if (wait !== null) await waitForChange(res, code(), wait, token);
      // The client left during the wait, so nobody reads an answer.
      if (res.destroyed) return;
      return send(res, 200, await store.get(code(), token));
    }
    case 'GET /api/sessions/{code}/events':
      return openStream(req, res, code(), asPlayerToken(url.searchParams.get('player')));
    case 'PATCH /api/sessions/{code}': {
      const changes = parseSessionUpdate(await readJson(req));
      if (changes === undefined) {
        throw new HttpError(400, 'An update needs a name of 1 to 40 characters, hideBoard, hideHistory or a valid clock.');
      }
      return send(res, 200, await store.update(code(), requirePlayer(req), changes));
    }
    case 'POST /api/sessions/{code}/lock':
      return send(res, 200, await store.lock(code(), requirePlayer(req)));
    case 'POST /api/sessions/{code}/join':
      return send(res, 200, await store.join(code(), requirePlayer(req)));
    case 'POST /api/sessions/{code}/moves': {
      const move = parseMoveRequest(await readJson(req));
      if (move === undefined) throw new HttpError(400, 'A move needs game, moveCount and cell.');
      return send(res, 200, await store.move(code(), requirePlayer(req), move));
    }
    case 'POST /api/sessions/{code}/games':
      return send(res, 200, await store.newGame(code(), requirePlayer(req)));
    case 'POST /api/sessions/{code}/chat': {
      const body = await readJson(req);
      const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
      return send(res, 200, await store.chat(code(), requirePlayer(req), text));
    }
    default: {
      const unhandled: never = match.route;
      throw new Error(`no handler for the documented route ${String(unhandled)}`);
    }
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    if (error instanceof SessionError || error instanceof HttpError) return send(res, error.status, { error: error.message });
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    else res.end();
  });
});

// Comments keep idle event streams open through proxies.
setInterval(() => {
  for (const set of streams.values()) for (const stream of set) stream.res.write(': ping\n\n');
}, 25_000).unref();

server.listen(PORT, () =>
  console.log(`tick3d api on :${PORT}, db ${dbPath}, login ${auth === undefined ? 'off' : 'on'}${lanHost ? `, LAN host ${lanHost.name}` : ''}`),
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    for (const set of streams.values()) for (const stream of set) stream.res.end();
    store.close();
    process.exit(0);
  });
}

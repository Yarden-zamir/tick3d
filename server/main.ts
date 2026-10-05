import { hostname } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Player } from '../src/game.ts';
import { NO_LIMIT, parseClock } from '../src/clock.ts';
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
  parseSessionUpdate,
} from '../src/protocol.ts';
import { SessionError } from '../src/session/core.ts';
import { type Auth, authConfigFromEnv, clientOf, createAuth, createLimiter } from './auth.ts';
import { openStore } from './store.ts';

const PORT = 8080;
const MAX_BODY_BYTES = 4096;
// A result upload carries up to RESULTS_PER_UPLOAD finished games of about 1 kB each.
const MAX_RESULTS_BODY_BYTES = 256 * 1024;
// An event is a short message, its kind and the app version.
const MAX_EVENT_BODY_BYTES = 1024;
// Each open page holds one event stream. This cap keeps a flood of streams from exhausting memory.
const MAX_STREAMS = 2000;
// Session codes are never freed, so one client must not use them all up: 60 new sessions per hour.
// Limit: the counts live in this process only and reset on a restart. An IPv6 client can change
// its address. Revisit this with more than one API process, a real attack, or real players that
// share one address and hit the limit (a school, for example).
const allowCreate = createLimiter(60, 3_600_000, 10_000);
// Fault reports from pages: 30 per 10 minutes per address is plenty for a page that works, and
// keeps a broken or hostile page from filling the events table. Same limits as allowCreate.
const allowEvent = createLimiter(30, 600_000, 10_000);

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

// Tells every open page of a session to fetch it again.
function notify(code: Code): void {
  for (const stream of streams.get(code) ?? []) stream.res.write('data: changed\n\n');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
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

async function authRoute(req: IncomingMessage, res: ServerResponse, url: URL, action: string | undefined): Promise<void> {
  if (auth === undefined) throw new HttpError(404, 'Login is not available on this server.');
  switch (`${req.method} ${action ?? ''}`) {
    case 'GET login': {
      const { location, cookies } = auth.start(originOf(req), url.searchParams.get('return'));
      return redirect(res, location, cookies);
    }
    case 'GET github': {
      // /api/auth/github/callback
      if (!url.pathname.endsWith('/callback')) throw new HttpError(404, 'Not found.');
      try {
        const { location, cookies } = await auth.finish(req, url.searchParams.get('code'), url.searchParams.get('state'));
        return redirect(res, location, cookies);
      } catch (error) {
        console.error('login failed:', error instanceof Error ? error.message : error);
        return redirect(res, '/?login=failed', []);
      }
    }
    case 'POST logout': {
      // A cross-site form cannot send the X-Player header, so another site cannot log a player out.
      await store.unlinkToken(requirePlayer(req));
      return send(res, 200, { ok: true }, { 'set-cookie': auth.logoutCookie() });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const [api, resource, second, action, ...rest] = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  if (api !== 'api') throw new HttpError(404, 'Not found.');

  if (resource === 'health' && method === 'GET') return send(res, 200, { ok: true, lan: lanHost });
  if (resource === 'auth') return authRoute(req, res, url, second);

  if (resource === 'me') {
    const known = [undefined, 'games', 'history', 'records'];
    // DELETE /api/me/history clears the history. A cross-site form cannot send the X-Player header.
    const clear = method === 'DELETE' && second === 'history';
    if ((method !== 'GET' && !clear) || !known.includes(second) || action !== undefined) throw new HttpError(404, 'Not found.');
    const token = requirePlayer(req);
    const user = auth?.user(req);
    // Every visit with a login links this browser to the account, so a new device joins at once.
    if (user !== undefined) await store.linkToken(token, user);
    if (second === 'games') return send(res, 200, await store.myGames(token));
    if (clear) return send(res, 200, { hidden: await store.clearHistory(token) });
    if (second === 'history') {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'The offset is not a whole number of games.');
      return send(res, 200, await store.history(token, offset));
    }
    if (second === 'records') return send(res, 200, { records: await store.records(token) });
    return send(res, 200, { loginAvailable: auth !== undefined, user: user === undefined ? null : { login: user.login, avatar: user.avatar } });
  }

  if (resource === 'results' && second === undefined && method === 'POST') {
    const body = await readJson(req, MAX_RESULTS_BODY_BYTES);
    const results = typeof body === 'object' && body !== null && 'results' in body ? body.results : undefined;
    if (!Array.isArray(results) || results.length > RESULTS_PER_UPLOAD) {
      throw new HttpError(400, `An upload needs a results list of at most ${RESULTS_PER_UPLOAD}.`);
    }
    return send(res, 200, await store.addResults(requirePlayer(req), results));
  }

  // A read-only game link. Anybody with the id may read the game, so the answer holds no token.
  if (resource === 'games' && second !== undefined && action === undefined && method === 'GET') {
    const id = parseGameId(second);
    if (id === undefined) throw new HttpError(400, 'A game id is 8 letters or digits, or a code and a game number.');
    return send(res, 200, await store.game(id));
  }

  // The metrics of one player's device for a finished online game.
  if (resource === 'games' && second !== undefined && action === 'metrics' && method === 'POST') {
    const id = parseGameId(second);
    if (id === undefined) throw new HttpError(400, 'A game id is 8 letters or digits, or a code and a game number.');
    const metrics = parseMetrics(await readJson(req));
    if (metrics === undefined) throw new HttpError(400, 'The metrics are not valid.');
    return send(res, 200, { stored: await store.addSeatMetrics(id, requirePlayer(req), metrics) });
  }

  if (resource === 'events' && second === undefined && method === 'POST') {
    if (!allowEvent(clientOf(req), Date.now())) throw new HttpError(429, 'Too many reports from this address. Try again later.');
    const event = parseClientEvent(await readJson(req, MAX_EVENT_BODY_BYTES));
    if (event === undefined) throw new HttpError(400, 'An event needs a kind, a message of 1 to 300 characters and a version.');
    await store.addEvent(event);
    return send(res, 200, { ok: true });
  }

  // Aggregates only (see server/stats.ts), so the hidden stats page needs no login.
  if (resource === 'stats' && second === undefined && method === 'GET') return send(res, 200, await store.stats());

  if (resource !== 'sessions' || rest.length > 0) throw new HttpError(404, 'Not found.');

  if (second === undefined) {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!allowCreate(clientOf(req), Date.now())) throw new HttpError(429, 'Too many new games from this address. Try again later.');
    const body = await readJson(req);
    const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};
    const clock = fields.clock === undefined ? NO_LIMIT : parseClock(fields.clock);
    if (clock === undefined) throw new HttpError(400, 'The time limit is out of range.');
    const name = typeof fields.name === 'string' ? fields.name : '';
    return send(res, 201, await store.create(requirePlayer(req), name, clock));
  }

  const code = normalizeCode(second);
  if (code === undefined) throw new HttpError(400, 'A code has 4 letters or digits.');

  switch (`${method} ${action ?? ''}`) {
    case 'GET ':
      return send(res, 200, await store.get(code, asPlayerToken(req.headers['x-player'])));
    case 'GET events':
      return openStream(req, res, code, asPlayerToken(url.searchParams.get('player')));
    case 'PATCH ': {
      const changes = parseSessionUpdate(await readJson(req));
      if (changes === undefined) {
        throw new HttpError(400, 'An update needs a name of 1 to 40 characters, hideBoard, hideHistory or a valid clock.');
      }
      return send(res, 200, await store.update(code, requirePlayer(req), changes));
    }
    case 'POST lock':
      return send(res, 200, await store.lock(code, requirePlayer(req)));
    case 'POST join':
      return send(res, 200, await store.join(code, requirePlayer(req)));
    case 'POST moves': {
      const move = parseMoveRequest(await readJson(req));
      if (move === undefined) throw new HttpError(400, 'A move needs game, moveCount and cell.');
      return send(res, 200, await store.move(code, requirePlayer(req), move));
    }
    case 'POST games':
      return send(res, 200, await store.newGame(code, requirePlayer(req)));
    case 'POST chat': {
      const body = await readJson(req);
      const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
      return send(res, 200, await store.chat(code, requirePlayer(req), text));
    }
    default:
      throw new HttpError(404, 'Not found.');
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

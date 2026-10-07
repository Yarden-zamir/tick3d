import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type Code,
  type PlayerToken,
  RESULTS_PER_UPLOAD,
  asPlayerToken,
  normalizeCode,
  parseClientEvent,
  parseCustomName,
  parseGameId,
  parseMetrics,
  parseMoveRequest,
  parseNewSession,
  parseSeatAction,
  parseSeatAnswer,
  parseSessionUpdate,
} from '../src/protocol.ts';
import { asHostId, parseAnnounce, parseAnswerRequest } from '../src/nearby/lobby.ts';
import { type Hello, decodeSignal } from '../src/nearby/signal.ts';
import { EMPTY_SESSION_TTL_MS, SessionError } from '../src/session/core.ts';
import {
  CREATES_PER_HOUR,
  EVENTS_PER_10_MINUTES,
  NEARBY_CALLS_PER_10_MINUTES,
  NEARBY_GRACE_MS,
  NEARBY_HOSTS_PER_NETWORK,
  PRACTICE_RUNS_PER_10_MINUTES,
  ROUTES,
  type Route,
  WAIT_MS,
  matchRoute,
} from './api-docs.ts';
import { openApi, swaggerHtml } from './api-docs-render.ts';
import { type Auth, authConfigFromEnv, clientOf, createAuth, createLimiter } from './auth.ts';
import { IDEMPOTENCY_TTL_MS, type StoredAnswer, createIdempotency, parseIdempotencyKey } from './idempotency.ts';
import { LobbyError, createLobby, networkOf } from './lobby.ts';
import { type PreviewList, createPreviews, previewsConfigFromEnv } from './previews.ts';
import { parsePlayoffRequest } from '../src/practice/playoff.ts';
import { parseBoardQuery, parsePracticeRun } from '../src/practice/practice.ts';
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
// Nearby lobby calls (announce and answer) per network. A host sends one announce per WAIT_MS and
// one per guest, so the limit leaves room for several hosts on one home network. Same limits as allowCreate.
const allowNearby = createLimiter(NEARBY_CALLS_PER_10_MINUTES, 600_000, 10_000);
// Practice runs per address: a run takes about half a minute, so 60 per 10 minutes leaves room for a
// classroom on one address. Same limits as allowCreate.
const allowPracticeRun = createLimiter(PRACTICE_RUNS_PER_10_MINUTES, 600_000, 10_000);
// Each entry holds at most one open request, so `total` also caps the open announce requests.
const lobby = createLobby({ perNetwork: NEARBY_HOSTS_PER_NETWORK, total: 1000, waitMs: WAIT_MS, graceMs: NEARBY_GRACE_MS });

// Answers to requests with an Idempotency-Key (server/idempotency.ts). An answer is a few kB, so
// 5000 keys keep the memory small. Revisit this when keys go before their time (more than 5000 changes per hour).
const idempotency = createIdempotency({ ttlMs: IDEMPOTENCY_TTL_MS, max: 5000 });
// The keyed requests that run now, by their response. send() stores the answer of each.
const keyed = new WeakMap<ServerResponse, { finish(answer: StoredAnswer): void; abandon(): void }>();

class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// A 429 that says in Retry-After how many whole seconds the client waits.
const tooMany = (message: string, retryAfterMs: number) =>
  new HttpError(429, message, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH is required');
const authConfig = authConfigFromEnv(process.env);
const auth: Auth | undefined = authConfig === undefined ? undefined : createAuth(authConfig);
// LAN_HOST=1 marks a server that a player runs on their own computer for a local network.
const lanHost = process.env.LAN_HOST === '1' ? { name: process.env.LAN_HOST_NAME || hostname() } : null;
const previewsConfig = previewsConfigFromEnv(process.env);
const previews: PreviewList | undefined = previewsConfig === undefined ? undefined : createPreviews(previewsConfig);

// Event streams per session code, with the player token of each. They live in this process only,
// which is fine for one API container. A seat with an open stream is "present", and a token without
// a seat is a watcher. Long polls do not count: an API client shows as away, as before.
type Stream = { res: ServerResponse; token: PlayerToken | undefined };
const streams = new Map<Code, Set<Stream>>();
let streamCount = 0;

function openTokens(code: Code): PlayerToken[] {
  return [...(streams.get(code) ?? [])].flatMap((stream) => (stream.token === undefined ? [] : [stream.token]));
}

const store = await openStore(dbPath, { open: openTokens, onChange: notify });

// A new name reaches the sessions that the player has open now. Other sessions show it with their next change.
function notifyPlayer(token: PlayerToken): void {
  for (const [code, set] of streams) if ([...set].some((stream) => stream.token === token)) notify(code);
}

// Tells every open page of a session to fetch it again, and wakes its long polls.
function notify(code: Code): void {
  for (const stream of streams.get(code) ?? []) stream.res.write('data: changed\n\n');
  waiters.wake(code);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body);
  const request = keyed.get(res);
  if (request !== undefined) {
    keyed.delete(res);
    // A server error is not the answer to the request, so a retry runs it again.
    if (status >= 500) request.abandon();
    else request.finish({ status, body: text, headers });
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
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

// The body of each request, read once: a keyed request reads it before its route, to compare repeats.
const bodies = new WeakMap<IncomingMessage, Promise<Buffer>>();

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const known = bodies.get(req);
  if (known !== undefined) return known;
  const reading = (async () => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > limit) throw new HttpError(413, 'Request body is too large.');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  })();
  bodies.set(req, reading);
  return reading;
}

async function readJson(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<unknown> {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

// Handles the Idempotency-Key header of a route that accepts it. Returns true when a stored answer went out.
// Without a valid X-Player header, the route refuses the request itself, so nothing is stored.
async function replayed(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const key = parseIdempotencyKey(req.headers['idempotency-key']);
  if (key instanceof Error) throw new HttpError(400, key.message);
  const player = asPlayerToken(req.headers['x-player']);
  if (key === undefined || player === undefined) return false;
  const body = await readBody(req, MAX_BODY_BYTES);
  const request = `${req.method ?? ''} ${path}\n${createHash('sha256').update(body).digest('base64')}`;
  const claim = idempotency.claim(`${player}\n${path}`, key, request, Date.now());
  switch (claim.kind) {
    case 'mismatch':
      throw new HttpError(422, 'This Idempotency-Key came with another request before. Use a new key for a new request.');
    case 'running':
      throw new HttpError(409, 'The first request with this Idempotency-Key still runs. Try again in a moment.');
    case 'replay':
      res.writeHead(claim.answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...claim.answer.headers });
      res.end(claim.answer.body);
      return true;
    case 'run':
      keyed.set(res, claim);
      // A request that ends without an answer (the client left, for example) frees its key.
      res.on('close', () => {
        if (keyed.get(res) !== claim) return;
        keyed.delete(res);
        claim.abandon();
      });
      return false;
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

// The lobby only shows a host to requests from its own network, so a request without a known address gets nothing.
function requireNetwork(req: IncomingMessage): string {
  const network = networkOf(clientOf(req));
  if (network === undefined) throw new HttpError(400, 'The server cannot tell the network of this request.');
  return network;
}

function requireNearbyCall(network: string): void {
  const limit = allowNearby(network, Date.now());
  if (!limit.ok) throw tooMany('Too many Nearby calls from this network. Try again later.', limit.retryAfterMs);
}

// Decodes a signal code fully, so the lobby never holds a code that a device cannot read.
async function signalHello(code: string, kind: 'offer' | 'answer'): Promise<Hello> {
  const signal = await decodeSignal(code).catch(() => undefined);
  if (signal?.kind !== kind) throw new HttpError(400, `This is not a valid tick3d ${kind} code.`);
  return signal.hello;
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
  await store.get(code, token); // 404 before the stream opens
  // The client can leave during the await. Its close event is then already past, so no handler runs.
  if (req.destroyed || res.destroyed) return;
  if (streamCount >= MAX_STREAMS) throw new HttpError(503, 'Too many live connections. Try again later.');
  const set = streams.get(code) ?? new Set();
  const stream: Stream = { res, token };
  req.on('close', () => {
    set.delete(stream);
    streamCount--;
    if (set.size === 0) streams.delete(code);
    if (token !== undefined) notify(code);
  });
  streams.set(code, set);
  set.add(stream);
  streamCount++;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  // A player or a watcher arriving changes what the others see ("away" turns into "here", a new watcher).
  if (token !== undefined) notify(code);
}

// The answer of GET /api/me: the login state and the custom name.
async function me(token: PlayerToken, user: ReturnType<Auth['user']>) {
  return {
    loginAvailable: auth !== undefined,
    user: user === undefined ? null : { login: user.login, avatar: user.avatar },
    name: await store.customName(token),
  };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  // Every route goes through matchRoute, so every route that the server handles has docs.
  const match = matchRoute(method, url.pathname);
  if (match === undefined) throw new HttpError(404, 'Not found.');
  if (match === 'wrong-method') throw new HttpError(405, 'Method not allowed.');
  const doc: Route = ROUTES[match.route];
  if (doc.idempotencyKey === true && (await replayed(req, res, url.pathname))) return;
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
    case 'GET /api/docs':
      return sendText(res, 'text/html; charset=utf-8', swaggerHtml());

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
      return send(res, 200, await me(token, user));
    }
    // A cross-site form cannot send the X-Player header, so another site cannot rename a player.
    case 'PUT /api/me/name': {
      const token = requirePlayer(req);
      const body = await readJson(req);
      const name = parseCustomName(typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined);
      if (name === undefined) throw new HttpError(400, 'A name needs 2 to 24 letters, digits, spaces, "-" or "_".');
      await store.setName(token, name);
      notifyPlayer(token);
      return send(res, 200, await me(token, auth?.user(req)));
    }
    case 'DELETE /api/me/name': {
      const token = requirePlayer(req);
      await store.clearName(token);
      notifyPlayer(token);
      return send(res, 200, await me(token, auth?.user(req)));
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
      const limit = allowEvent(clientOf(req), Date.now());
      if (!limit.ok) throw tooMany('Too many reports from this address. Try again later.', limit.retryAfterMs);
      const event = parseClientEvent(await readJson(req, MAX_EVENT_BODY_BYTES));
      if (event === undefined) throw new HttpError(400, 'An event needs a kind, a message of 1 to 300 characters and a version.');
      await store.addEvent(event);
      return send(res, 200, { ok: true });
    }
    case 'POST /api/practice/runs': {
      if (!allowPracticeRun(clientOf(req), Date.now())) throw new HttpError(429, 'Too many practice runs from this address. Try again later.');
      const token = requirePlayer(req);
      const run = parsePracticeRun(await readJson(req));
      if (run === undefined) throw new HttpError(400, 'The run is not one that the practice room can make.');
      return send(res, 200, await store.addPracticeRun(token, run));
    }
    case 'GET /api/practice/best': {
      const query = parseBoardQuery(url.searchParams.get('mode'), url.searchParams.get('preset'));
      if (query === undefined) throw new HttpError(400, 'A leaderboard needs a mode (targets or echo) and a preset (easy, normal or hard).');
      const header = req.headers['x-player'];
      const token = asPlayerToken(header);
      if (header !== undefined && token === undefined) throw new HttpError(400, 'Invalid X-Player header.');
      return send(res, 200, await store.practiceBoard(query.mode, query.preset, token));
    }
    // Aggregates only (see server/stats.ts), so the hidden stats page needs no login.
    case 'GET /api/stats':
      return send(res, 200, await store.stats());
    // Cached in server/previews.ts, so a flood of requests costs no extra GitHub calls and needs no limiter.
    case 'GET /api/previews':
      return send(res, 200, previews === undefined ? { main: null, previews: [], error: 'This server has no previews.' } : await previews.list());

    case 'POST /api/sessions': {
      const limit = allowCreate(clientOf(req), Date.now());
      if (!limit.ok) throw tooMany('Too many new games from this address. Try again later.', limit.retryAfterMs);
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
        throw new HttpError(400, 'An update needs a name of 1 to 40 characters, hideBoard, hideHistory, hideCoordinates, fixedSeats or a valid clock.');
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
    case 'POST /api/sessions/{code}/seats': {
      const action = parseSeatAction(await readJson(req));
      if (action === undefined) throw new HttpError(400, 'A seat change needs an action, and a watcher id for give, seat and replace.');
      return send(res, 200, await store.seat(code(), requirePlayer(req), action));
    }
    case 'POST /api/sessions/{code}/seats/answer': {
      const answer = parseSeatAnswer(await readJson(req));
      if (answer === undefined) throw new HttpError(400, 'An answer needs accept: true or false.');
      return send(res, 200, await store.answerSeat(code(), requirePlayer(req), answer.accept));
    }
    case 'POST /api/sessions/{code}/chat': {
      const body = await readJson(req);
      const text = typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
      return send(res, 200, await store.chat(code(), requirePlayer(req), text));
    }

    case 'POST /api/sessions/{code}/playoff': {
      const request = parsePlayoffRequest(await readJson(req));
      if (request === undefined) throw new HttpError(400, 'A playoff request is start (preset, seed), join (id), leave (id) or hit (id, index, ms).');
      return send(res, 200, await store.playoff(code(), requirePlayer(req), request));
    }

    case 'GET /api/nearby/hosts':
      return send(res, 200, { hosts: lobby.list(requireNetwork(req), asPlayerToken(req.headers['x-player'])) });
    case 'POST /api/nearby/hosts': {
      const token = requirePlayer(req);
      const network = requireNetwork(req);
      requireNearbyCall(network);
      const body = parseAnnounce(await readJson(req));
      if (body === undefined) throw new HttpError(400, 'An announcement needs an offer code, and an id from an earlier answer or none.');
      const hello = await signalHello(body.offer, 'offer');
      const left = new AbortController();
      // The response closes before it ends only when the host goes away.
      const onClose = () => left.abort();
      res.on('close', onClose);
      try {
        const { id, answer } = lobby.announce({ id: body.id, token, network, hello, offer: body.offer }, left.signal);
        const code = await answer;
        if (res.destroyed) return;
        return send(res, 200, { id, answer: code });
      } finally {
        res.off('close', onClose);
      }
    }
    case 'POST /api/nearby/hosts/{host}/answer': {
      const id = asHostId(match.params.host);
      if (id === undefined) throw new HttpError(400, 'A host id has 16 characters.');
      requirePlayer(req);
      const network = requireNetwork(req);
      requireNearbyCall(network);
      const body = parseAnswerRequest(await readJson(req));
      if (body === undefined) throw new HttpError(400, 'An answer needs an answer code and the offer code that it answers.');
      await signalHello(body.answer, 'answer');
      lobby.answer(id, network, body.offer, body.answer);
      return send(res, 200, { ok: true });
    }
    default: {
      const unhandled: never = match.route;
      throw new Error(`no handler for the documented route ${String(unhandled)}`);
    }
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    if (error instanceof SessionError) return send(res, error.status, { error: error.message, ...(error.code === undefined ? {} : { code: error.code }) });
    if (error instanceof HttpError) return send(res, error.status, { error: error.message }, error.headers);
    if (error instanceof LobbyError) return send(res, error.status, { error: error.message }, error.headers);
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    else res.end();
  });
});

// Sessions that nobody played go after a while, at start and then every hour.
async function pruneEmptySessions(): Promise<void> {
  const deleted = await store.pruneEmpty(EMPTY_SESSION_TTL_MS);
  if (deleted.length > 0) console.log(`pruned ${deleted.length} empty sessions`);
}
void pruneEmptySessions().catch((error: unknown) => console.error('pruning empty sessions failed', error));
setInterval(() => void pruneEmptySessions().catch((error: unknown) => console.error('pruning empty sessions failed', error)), 3_600_000).unref();

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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NO_LIMIT, parseClock } from '../src/clock.ts';
import {
  type Code,
  type PlayerToken,
  asPlayerToken,
  normalizeCode,
  parseMoveRequest,
  parseSessionUpdate,
} from '../src/protocol.ts';
import { StoreError, openStore } from './store.ts';

const PORT = 8080;
const MAX_BODY_BYTES = 4096;
// Each open page holds one event stream. This cap keeps a flood of streams from exhausting memory.
const MAX_STREAMS = 2000;

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH is required');
const store = openStore(dbPath);

// Event streams per session code. They live in this process only, which is fine for one API container.
const streams = new Map<Code, Set<ServerResponse>>();
let streamCount = 0;

function notify(code: Code, version: number): void {
  for (const stream of streams.get(code) ?? []) stream.write(`data: ${version}\n\n`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new StoreError(400, 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new StoreError(400, 'Request body is not valid JSON.');
  }
}

function requirePlayer(req: IncomingMessage): PlayerToken {
  const player = asPlayerToken(req.headers['x-player']);
  if (player === undefined) throw new StoreError(400, 'Missing or invalid X-Player header.');
  return player;
}

function openStream(req: IncomingMessage, res: ServerResponse, code: Code): void {
  store.get(code, undefined); // 404 before the stream opens
  if (streamCount >= MAX_STREAMS) throw new StoreError(409, 'Too many live connections. Try again later.');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const set = streams.get(code) ?? new Set();
  streams.set(code, set);
  set.add(res);
  streamCount++;
  req.on('close', () => {
    set.delete(res);
    streamCount--;
    if (set.size === 0) streams.delete(code);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const [api, resource, rawCode, action, ...rest] = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  if (api !== 'api' || rest.length > 0) throw new StoreError(404, 'Not found.');

  if (resource === 'health' && rawCode === undefined && method === 'GET') return send(res, 200, { ok: true });
  if (resource !== 'sessions') throw new StoreError(404, 'Not found.');

  if (rawCode === undefined) {
    if (method !== 'POST') throw new StoreError(405, 'Method not allowed.');
    const body = await readJson(req);
    const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};
    const clock = fields.clock === undefined ? NO_LIMIT : parseClock(fields.clock);
    if (clock === undefined) throw new StoreError(400, 'The time limit is out of range.');
    const name = typeof fields.name === 'string' ? fields.name : '';
    return send(res, 201, store.create(requirePlayer(req), name, clock));
  }

  const code = normalizeCode(rawCode);
  if (code === undefined) throw new StoreError(400, 'A code has 4 letters or digits.');

  const mutate = (view: ReturnType<typeof store.get>) => {
    notify(code, view.version);
    send(res, 200, view);
  };

  switch (`${method} ${action ?? ''}`) {
    case 'GET ':
      return send(res, 200, store.get(code, asPlayerToken(req.headers['x-player'])));
    case 'GET events':
      return openStream(req, res, code);
    case 'PATCH ': {
      const changes = parseSessionUpdate(await readJson(req));
      if (changes === undefined) {
        throw new StoreError(400, 'An update needs a name of 1 to 40 characters, hideBoard, hideHistory or a valid clock.');
      }
      return mutate(store.update(code, requirePlayer(req), changes));
    }
    case 'POST lock':
      return mutate(store.lock(code, requirePlayer(req)));
    case 'POST join':
      return mutate(store.join(code, requirePlayer(req)));
    case 'POST moves': {
      const move = parseMoveRequest(await readJson(req));
      if (move === undefined) throw new StoreError(400, 'A move needs game, moveCount and cell.');
      return mutate(store.move(code, requirePlayer(req), move));
    }
    case 'POST games':
      return mutate(store.newGame(code, requirePlayer(req)));
    default:
      throw new StoreError(404, 'Not found.');
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    if (error instanceof StoreError) return send(res, error.status, { error: error.message });
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    else res.end();
  });
});

// Comments keep idle event streams open through proxies.
setInterval(() => {
  for (const set of streams.values()) for (const stream of set) stream.write(': ping\n\n');
}, 25_000).unref();

server.listen(PORT, () => console.log(`tick3d api on :${PORT}, db ${dbPath}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    for (const set of streams.values()) for (const stream of set) stream.end();
    store.close();
    process.exit(0);
  });
}

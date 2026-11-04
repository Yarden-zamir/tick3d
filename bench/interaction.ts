// The online game loop: `pairs` pairs play `rounds` games each, at the same time. Player A makes a session, B joins and
// listens, then they play X 0 1 2 3 and O 16 17 18 (7 moves).
// It measures each move request (POST /moves until its answer) and the delivery: from the start of a move request until
// the opponent's channel shows the new version. `channel` is `ws` (the page's WebSocket: moves and views over one
// socket per player), `sse` (the earlier page: a request per move and an event stream) or `poll` (the agent API,
// GET ?wait=<version>).
// Usage: node bench/interaction.ts <base url> <pairs> <rounds> <ws|sse|poll>
import { tokenOf } from './tokens.ts';

const [base, pairsText, roundsText, channel] = process.argv.slice(2);
if (base === undefined || pairsText === undefined || roundsText === undefined || (channel !== 'ws' && channel !== 'sse' && channel !== 'poll')) {
  throw new Error('usage: interaction.ts <base> <pairs> <rounds> <ws|sse|poll>');
}
const pairs = Number(pairsText);
const rounds = Number(roundsText);
const MOVES = [0, 16, 1, 17, 2, 18, 3];
type View = { code: string; version: number };

const moveMs: number[] = [];
const deliveryMs: number[] = [];

async function call(token: string, client: string, method: string, path: string, body?: object): Promise<View> {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'x-player': token, 'x-forwarded-for': client, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as View;
}

/// The versions that one player sees on the event stream, with a waiter for a version.
function listen(code: string, token: string, stream: string) {
  let seen = 0;
  const waiters: { version: number; done: () => void }[] = [];
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${base}/api/sessions/${code}/events?player=${token}&stream=${stream}`, { signal: controller.signal });
    if (response.body === null) throw new Error('no event stream');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split('\n').find((line) => line.startsWith('data:'));
        if (data === undefined) continue;
        const text = data.slice(5).trim();
        // "changed": the stream opened during a push, so the page fetches its view, as here.
        const view = text === 'changed' ? await call(token, '127.0.0.1', 'GET', `/sessions/${code}`) : (JSON.parse(text) as View);
        if (view.version > seen) seen = view.version;
        for (const waiter of waiters.filter((w) => w.version <= seen)) waiter.done();
        waiters.splice(0, waiters.length, ...waiters.filter((w) => w.version > seen));
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  return {
    until: (version: number) => (version <= seen ? Promise.resolve() : new Promise<void>((done) => waiters.push({ version, done }))),
    close: () => controller.abort(),
  };
}

/// One socket of a player: actions with their answers, and the versions of the watched sessions.
async function socketOf(token: string) {
  const socket = new WebSocket(`${(base as string).replace(/^http/, 'ws')}/api/ws?player=${token}`);
  const replies = new Map<number, (view: View) => void>();
  const seen = new Map<string, number>();
  let waiters: { code: string; version: number; done: () => void }[] = [];
  let id = 0;
  socket.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as { id?: number; status?: number; body?: View; code?: string; view?: View | 'changed' };
    if (message.id !== undefined) {
      if (message.status !== 200) throw new Error(`socket action: ${message.status} ${JSON.stringify(message.body)}`);
      replies.get(message.id)?.(message.body as View);
      replies.delete(message.id);
      return;
    }
    if (message.code === undefined || typeof message.view !== 'object') return;
    const version = Math.max(seen.get(message.code) ?? 0, message.view.version);
    seen.set(message.code, version);
    for (const waiter of waiters.filter((w) => w.code === message.code && w.version <= version)) waiter.done();
    waiters = waiters.filter((w) => !(w.code === message.code && w.version <= version));
  };
  await new Promise((done, failed) => {
    socket.onopen = done;
    socket.onerror = failed;
  });
  return {
    act: (method: string, path: string, body: object) =>
      new Promise<View>((done) => {
        id += 1;
        replies.set(id, done);
        socket.send(JSON.stringify({ id, method, path, body }));
      }),
    watch: (code: string) => socket.send(JSON.stringify({ watch: code })),
    unwatch: (code: string) => socket.send(JSON.stringify({ unwatch: code })),
    until: (code: string, version: number) =>
      (seen.get(code) ?? 0) >= version ? Promise.resolve() : new Promise<void>((done) => waiters.push({ code, version, done })),
    close: () => socket.close(),
  };
}

async function pair(index: number): Promise<void> {
  if (channel === 'ws') return socketPair(index);
  const [a, b] = [tokenOf(1_000_000 + index * 2), tokenOf(1_000_001 + index * 2)];
  for (let round = 0; round < rounds; round++) {
    // Each session comes from its own address, so the limit of new games per address does not stop the run.
    const client = `10.${(index >> 8) & 255}.${index & 255}.${round & 255}`;
    const created = await call(a, client, 'POST', '/sessions', { name: 'bench' });
    const code = created.code;
    const sse = channel === 'sse' ? [listen(code, a, `a${index}-${round}`), listen(code, b, `b${index}-${round}`)] : [];
    let version = (await call(b, client, 'POST', `/sessions/${code}/join`)).version;
    for (const [n, cell] of MOVES.entries()) {
      const [mover, waiter] = n % 2 === 0 ? [a, b] : [b, a];
      const waiterIndex = n % 2 === 0 ? 1 : 0;
      const started = performance.now();
      // The delivery time is taken when the opponent's channel sees the version, which can come before the move answer.
      const delivered = (
        channel === 'sse'
          ? (sse[waiterIndex] as ReturnType<typeof listen>).until(version + 1)
          : call(waiter, client, 'GET', `/sessions/${code}?wait=${version}`).then(() => undefined)
      ).then(() => performance.now() - started);
      const moved = await call(mover, client, 'POST', `/sessions/${code}/moves`, { game: 0, moveCount: n, cell });
      moveMs.push(performance.now() - started);
      deliveryMs.push(await delivered);
      version = moved.version;
    }
    for (const listener of sse) listener.close();
  }
}

/// The same game loop over one socket per player. Create and join stay on HTTP, because the limit of new games counts
/// per address and a socket has one address.
async function socketPair(index: number): Promise<void> {
  const [a, b] = [tokenOf(1_000_000 + index * 2), tokenOf(1_000_001 + index * 2)];
  const sockets = [await socketOf(a), await socketOf(b)];
  for (let round = 0; round < rounds; round++) {
    const client = `10.${(index >> 8) & 255}.${index & 255}.${round & 255}`;
    const code = (await call(a, client, 'POST', '/sessions', { name: 'bench' })).code;
    for (const socket of sockets) socket.watch(code);
    let version = (await call(b, client, 'POST', `/sessions/${code}/join`)).version;
    for (const [n, cell] of MOVES.entries()) {
      const [mover, waiter] = n % 2 === 0 ? [sockets[0], sockets[1]] : [sockets[1], sockets[0]];
      const started = performance.now();
      const delivered = (waiter as Awaited<ReturnType<typeof socketOf>>).until(code, version + 1).then(() => performance.now() - started);
      const moved = await (mover as Awaited<ReturnType<typeof socketOf>>).act('POST', `/sessions/${code}/moves`, { game: 0, moveCount: n, cell });
      moveMs.push(performance.now() - started);
      deliveryMs.push(await delivered);
      version = moved.version;
    }
    for (const socket of sockets) socket.unwatch(code);
  }
  for (const socket of sockets) socket.close();
}

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((x, y) => x - y);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN).toFixed(2));
};
const summary = (values: number[]) => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90), p99: percentile(values, 99), max: percentile(values, 100) });

const started = performance.now();
await Promise.all(Array.from({ length: pairs }, (_, index) => pair(index)));
const seconds = (performance.now() - started) / 1000;
console.log(JSON.stringify({ channel, pairs, rounds, seconds: Number(seconds.toFixed(2)), movesPerSecond: Number((moveMs.length / seconds).toFixed(1)), move: summary(moveMs), delivery: summary(deliveryMs) }));

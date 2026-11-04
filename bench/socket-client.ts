// The benchmark's client of the page socket (GET /api/ws): actions with their answers, and the versions of the watched
// sessions. Once the socket closes, every pending and every later call rejects with the same error, so a broken run
// fails instead of hanging.
export type View = { code: string; version: number };

type Reply = { done: (view: View) => void; failed: (error: Error) => void };
type Waiter = { code: string; version: number; done: () => void; failed: (error: Error) => void };

export async function socketOf(url: string, create: (url: string) => WebSocket = (address) => new WebSocket(address)) {
  const socket = create(url);
  const replies = new Map<number, Reply>();
  const seen = new Map<string, number>();
  let waiters: Waiter[] = [];
  let ended: Error | undefined;
  let id = 0;
  const end = (error: Error) => {
    ended ??= error;
    for (const reply of replies.values()) reply.failed(ended);
    replies.clear();
    for (const waiter of waiters) waiter.failed(ended);
    waiters = [];
  };
  socket.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as { id?: number; status?: number; body?: View; code?: string; view?: View | 'changed' };
    if (message.id !== undefined) {
      const reply = replies.get(message.id);
      replies.delete(message.id);
      if (message.status === 200) reply?.done(message.body as View);
      else reply?.failed(new Error(`socket action: ${message.status} ${JSON.stringify(message.body)}`));
      return;
    }
    if (message.code === undefined || typeof message.view !== 'object') return;
    const version = Math.max(seen.get(message.code) ?? 0, message.view.version);
    seen.set(message.code, version);
    for (const waiter of waiters.filter((w) => w.code === message.code && w.version <= version)) waiter.done();
    waiters = waiters.filter((w) => !(w.code === message.code && w.version <= version));
  };
  socket.onclose = () => end(new Error(`the socket ${url} closed during the run`));
  await new Promise<void>((done, failed) => {
    socket.onopen = () => done();
    socket.onerror = () => failed(new Error(`the socket ${url} did not open`));
  });
  // A call after the end, or on a socket that is not open, fails at once: a send on a closed socket does nothing.
  const usable = (): Error | undefined => ended ?? (socket.readyState === WebSocket.OPEN ? undefined : new Error(`the socket ${url} is not open`));
  return {
    act: (method: string, path: string, body: object) =>
      new Promise<View>((done, failed) => {
        const error = usable();
        if (error !== undefined) return failed(error);
        id += 1;
        replies.set(id, { done, failed });
        socket.send(JSON.stringify({ id, method, path, body }));
      }),
    watch: (code: string) => socket.send(JSON.stringify({ watch: code })),
    unwatch: (code: string) => socket.send(JSON.stringify({ unwatch: code })),
    until: (code: string, version: number) =>
      new Promise<void>((done, failed) => {
        if ((seen.get(code) ?? 0) >= version) return done();
        const error = usable();
        if (error !== undefined) return failed(error);
        waiters.push({ code, version, done, failed });
      }),
    close: () => {
      socket.onclose = null;
      socket.close();
    },
  };
}

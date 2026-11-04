// One WebSocket per page for online play (GET /api/ws, rust/server/src/socket.rs). The page sends its session actions
// and gets the views of the sessions that it watches over this one connection. REST stays for everything else.
// If the socket never opens (a network or a proxy that blocks WebSockets), the page uses HTTP for the rest of its life.

// An answer of a socket action: the HTTP status and the JSON body of the same request over HTTP.
export type SocketAnswer = { status: number; body: unknown };

// Views of one watched session: an object, or undefined when the page must load the session.
type Watcher = (view: unknown) => void;

type Pending = { message: string; done: (answer: SocketAnswer) => void; failed: (error: Error) => void };

// A socket that did not open this many times in a row, without any open before, counts as blocked.
const FAILS_BEFORE_HTTP = 2;

export type SocketOptions = {
  url: string;
  // The retry wait after `failures` failed connections in a row.
  retryMs: (failures: number) => number;
  // Injected by tests.
  create?: (url: string) => WebSocket;
  // Called once when the socket counts as blocked: the page moves its watches to HTTP.
  onBlocked?: () => void;
};

export class PlaySocket {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private failures = 0;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiting = new Map<number, Pending>();
  // Actions that wait for the socket to open.
  private readonly queued: number[] = [];
  private readonly watches = new Map<string, Set<Watcher>>();
  // Set when the socket counts as blocked: every caller uses HTTP from then on.
  blocked = false;

  private readonly options: SocketOptions;

  constructor(options: SocketOptions) {
    this.options = options;
  }

  // Runs a session action over the socket. Rejects when the socket closes before the answer came: as with a request
  // whose connection broke, the action may or may not have happened.
  act(method: string, path: string, body?: unknown): Promise<SocketAnswer> {
    if (this.blocked) return Promise.reject(new Error('the socket is blocked'));
    this.nextId += 1;
    const id = this.nextId;
    const message = JSON.stringify({ id, method, path, ...(body === undefined ? {} : { body }) });
    return new Promise<SocketAnswer>((done, failed) => {
      this.waiting.set(id, { message, done, failed });
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
      else {
        this.queued.push(id);
        this.connect();
      }
    });
  }

  watch(code: string, watcher: Watcher): () => void {
    const set = this.watches.get(code) ?? new Set();
    const first = set.size === 0;
    set.add(watcher);
    this.watches.set(code, set);
    if (first) this.sendIfOpen({ watch: code });
    this.connect();
    return () => {
      set.delete(watcher);
      if (set.size > 0) return;
      this.watches.delete(code);
      this.sendIfOpen({ unwatch: code });
    };
  }

  private sendIfOpen(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    if (this.blocked || this.socket !== undefined || this.timer !== undefined) return;
    const socket = (this.options.create ?? ((url) => new WebSocket(url)))(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.opened = true;
      this.failures = 0;
      for (const code of this.watches.keys()) socket.send(JSON.stringify({ watch: code }));
      for (const id of this.queued.splice(0)) {
        const pending = this.waiting.get(id);
        if (pending !== undefined) socket.send(pending.message);
      }
    };
    socket.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    socket.onclose = () => this.closed(socket);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if ('id' in message && typeof message.id === 'number' && 'status' in message && typeof message.status === 'number') {
      const pending = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      pending?.done({ status: message.status, body: 'body' in message ? message.body : null });
      return;
    }
    if ('code' in message && typeof message.code === 'string') {
      // "changed", an error about the watch, or a view that this page cannot read: the page loads the session.
      const view = 'view' in message && typeof message.view === 'object' ? message.view : undefined;
      for (const watcher of this.watches.get(message.code) ?? []) watcher(view);
    }
  }

  private closed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    // Sent actions lose their answer; queued ones wait for the next socket.
    for (const [id, pending] of this.waiting) {
      if (this.queued.includes(id)) continue;
      this.waiting.delete(id);
      pending.failed(new Error('the socket closed'));
    }
    this.failures += 1;
    if (!this.opened && this.failures >= FAILS_BEFORE_HTTP) {
      this.block();
      return;
    }
    // After a reconnect the page loads each watched session, in case it missed a change.
    if (this.opened) for (const watchers of this.watches.values()) for (const watcher of watchers) watcher(undefined);
    if (this.watches.size === 0 && this.waiting.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, this.options.retryMs(this.failures - 1));
  }

  private block(): void {
    this.blocked = true;
    for (const pending of this.waiting.values()) pending.failed(new Error('the socket is blocked'));
    this.waiting.clear();
    this.queued.length = 0;
    this.options.onBlocked?.();
  }
}

import { describe, expect, it, vi } from 'vitest';
import { PlaySocket } from './socket.ts';

// A socket under the test's control: it opens, delivers and closes when the test says so.
class FakeSocket {
  static readonly made: FakeSocket[] = [];
  readyState: number = WebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.made.push(this);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  deliver(message: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

function playSocket(onBlocked = () => {}) {
  FakeSocket.made.length = 0;
  return new PlaySocket({ url: 'ws://test/api/ws', retryMs: () => 0, create: () => new FakeSocket() as unknown as WebSocket, onBlocked });
}
const last = () => FakeSocket.made.at(-1) as FakeSocket;

describe('PlaySocket', () => {
  it('sends an action once the socket opens and answers with its reply', async () => {
    const socket = playSocket();
    const answer = socket.act('POST', '/sessions/ABCD/moves', { cell: 3 });
    last().open();
    expect(last().sent).toEqual([{ id: 1, method: 'POST', path: '/sessions/ABCD/moves', body: { cell: 3 } }]);
    last().deliver({ id: 1, status: 200, body: { version: 4 } });
    await expect(answer).resolves.toEqual({ status: 200, body: { version: 4 } });
  });

  it('watches again after a reconnect, and tells the page to load the session', async () => {
    vi.useFakeTimers();
    const socket = playSocket();
    const views: unknown[] = [];
    socket.watch('ABCD', (view) => views.push(view));
    last().open();
    last().deliver({ code: 'ABCD', view: { version: 2 } });
    last().close();
    expect(views).toEqual([{ version: 2 }, undefined]);
    await vi.runAllTimersAsync();
    last().open();
    expect(last().sent).toEqual([{ watch: 'ABCD' }]);
    vi.useRealTimers();
  });

  it('rejects an action whose socket closed before the answer, as a broken request', async () => {
    const socket = playSocket();
    const answer = socket.act('POST', '/sessions/ABCD/games');
    last().open();
    last().close();
    await expect(answer).rejects.toThrow('the socket closed');
  });

  it('counts a socket that never opens as blocked, so the page moves to HTTP', async () => {
    vi.useFakeTimers();
    const blocked = vi.fn();
    const socket = playSocket(blocked);
    const answer = socket.act('POST', '/sessions', { name: 'x' });
    last().close();
    await vi.runAllTimersAsync();
    last().close();
    await expect(answer).rejects.toThrow('blocked');
    expect(socket.blocked).toBe(true);
    expect(blocked).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('stops the watch when the last watcher leaves', () => {
    const socket = playSocket();
    const stopA = socket.watch('ABCD', () => {});
    const stopB = socket.watch('ABCD', () => {});
    last().open();
    stopA();
    expect(last().sent).toEqual([{ watch: 'ABCD' }]);
    stopB();
    expect(last().sent).toEqual([{ watch: 'ABCD' }, { unwatch: 'ABCD' }]);
  });
});

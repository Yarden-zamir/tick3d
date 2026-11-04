import { describe, expect, it, vi } from 'vitest';
import { PlaySocket, SocketNotOpen } from './socket.ts';

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
  it('sends an action only over an open socket; before that, the caller uses HTTP and the socket connects', async () => {
    const socket = playSocket();
    await expect(socket.act('POST', '/sessions', { name: 'x' })).rejects.toBeInstanceOf(SocketNotOpen);
    expect(FakeSocket.made).toHaveLength(1);
    last().open();
    const answer = socket.act('POST', '/sessions/ABCD/moves', { cell: 3 });
    expect(last().sent).toEqual([{ id: 1, method: 'POST', path: '/sessions/ABCD/moves', body: { cell: 3 } }]);
    last().deliver({ id: 1, status: 200, body: { version: 4 } });
    await expect(answer).resolves.toEqual({ status: 200, body: { version: 4 } });
  });

  it('watches again after a reconnect, and the page loads the session only when the socket is back', async () => {
    vi.useFakeTimers();
    const socket = playSocket();
    const views: unknown[] = [];
    socket.watch('ABCD', (view) => views.push(view));
    last().open();
    last().deliver({ code: 'ABCD', view: { version: 2 } });
    last().close();
    // A close alone tells the page nothing: a dead channel delivers no change.
    expect(views).toEqual([{ version: 2 }]);
    await vi.runAllTimersAsync();
    last().open();
    expect(last().sent).toEqual([{ watch: 'ABCD' }]);
    // The server answers a watch with "changed" first, and then the page loads the session.
    last().deliver({ code: 'ABCD', view: 'changed' });
    expect(views).toEqual([{ version: 2 }, undefined]);
    vi.useRealTimers();
  });

  it('rejects an action whose socket closed before the answer, as a broken request', async () => {
    const socket = playSocket();
    socket.watch('ABCD', () => {});
    last().open();
    const answer = socket.act('POST', '/sessions/ABCD/games');
    last().close();
    await expect(answer).rejects.toThrow('the socket closed');
  });

  it('counts a socket that never opens as blocked, so the page moves to HTTP', async () => {
    vi.useFakeTimers();
    const blocked = vi.fn();
    const socket = playSocket(blocked);
    socket.watch('ABCD', () => {});
    last().close();
    await vi.runAllTimersAsync();
    last().close();
    expect(socket.blocked).toBe(true);
    expect(blocked).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('moves to HTTP after 5 failures in a row when the socket had opened, and a reopen resets the count', async () => {
    vi.useFakeTimers();
    const blocked = vi.fn();
    const socket = playSocket(blocked);
    socket.watch('ABCD', () => {});
    last().open();
    for (let failure = 0; failure < 4; failure++) {
      last().close();
      await vi.runAllTimersAsync();
    }
    // Four failures, then the socket works again: the count starts over.
    last().open();
    for (let failure = 0; failure < 4; failure++) {
      last().close();
      await vi.runAllTimersAsync();
    }
    expect(blocked).not.toHaveBeenCalled();
    last().close();
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

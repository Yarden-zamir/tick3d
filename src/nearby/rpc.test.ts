import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from './peer.ts';
import { RpcError, parseGuestMessage, parseHostMessage, rpcClient, rpcServer } from './rpc.ts';

// Two connected in-memory channels. Messages pass through JSON, as on a real data channel.
function channelPair(): [Channel, Channel] {
  type Side = { messages: ((message: unknown) => void)[]; closes: (() => void)[]; closed: boolean };
  const sides: [Side, Side] = [
    { messages: [], closes: [], closed: false },
    { messages: [], closes: [], closed: false },
  ];
  const closeBoth = () => {
    for (const side of sides) {
      if (side.closed) continue;
      side.closed = true;
      for (const handler of side.closes) handler();
    }
  };
  const make = (self: Side, other: Side): Channel => ({
    send(message) {
      if (self.closed) throw new Error('closed');
      const copy: unknown = JSON.parse(JSON.stringify(message));
      queueMicrotask(() => {
        if (other.closed) return;
        for (const handler of other.messages) handler(copy);
      });
    },
    onMessage(handler) {
      self.messages.push(handler);
    },
    onClose(handler) {
      self.closes.push(handler);
    },
    close: closeBoth,
  });
  return [make(sides[0], sides[1]), make(sides[1], sides[0])];
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('parsers', () => {
  it.each([
    [{ t: 'call', id: 1, method: 'move', args: { cell: 3 } }, true],
    [{ t: 'call', id: 1, method: 'get', args: null }, true],
    [{ t: 'call', id: 0, method: 'move', args: null }, false],
    [{ t: 'call', id: 1.5, method: 'move', args: null }, false],
    [{ t: 'call', id: 1, method: 'delete', args: null }, false],
    [{ t: 'call', id: 1, method: 'move' }, false],
    [{ t: 'call', id: 1, method: 'move', args: null, extra: 1 }, false],
    [{ t: 'result', id: 1, view: {} }, false],
    [[], false],
    ['call', false],
  ])('guest message %j is valid: %s', (value, valid) => {
    expect(parseGuestMessage(value) !== undefined).toBe(valid);
  });

  it.each([
    [{ t: 'result', id: 2, view: { any: 'thing' } }, true],
    [{ t: 'error', id: 2, status: 409, message: 'It is not your turn.' }, true],
    [{ t: 'error', id: 2, status: 200, message: 'ok' }, false],
    [{ t: 'error', id: 2, status: 409, message: 'x'.repeat(501) }, false],
    [{ t: 'changed' }, true],
    [{ t: 'changed', extra: true }, false],
    [{ t: 'bye', reason: 'The host left.' }, true],
    [{ t: 'bye' }, false],
    [{ t: 'call', id: 1, method: 'get', args: null }, false],
  ])('host message %j is valid: %s', (value, valid) => {
    expect(parseHostMessage(value) !== undefined).toBe(valid);
  });
});

describe('rpcClient and rpcServer', () => {
  it('answers calls, passes refusals on, and hides internal errors', async () => {
    const [guestSide, hostSide] = channelPair();
    rpcServer(hostSide, async (method, args) => {
      if (method === 'move') throw new RpcError(409, 'It is not your turn.');
      if (method === 'lock') throw new Error('database exploded with secret details');
      return { method, args };
    });
    const client = rpcClient(guestSide);
    expect(await client.call('get', { code: 'AB3K' })).toEqual({ method: 'get', args: { code: 'AB3K' } });
    await expect(client.call('move', { cell: 1 })).rejects.toMatchObject({ status: 409, message: 'It is not your turn.' });
    await expect(client.call('lock', null)).rejects.toMatchObject({ status: 500, message: 'The host had an error.' });
  });

  it('tells guests about changes and goodbyes', async () => {
    const [guestSide, hostSide] = channelPair();
    const server = rpcServer(hostSide, async () => ({}));
    const client = rpcClient(guestSide);
    const changed = vi.fn();
    const bye = vi.fn();
    client.onChanged(changed);
    client.onBye(bye);
    server.notifyChanged();
    await settle();
    expect(changed).toHaveBeenCalledOnce();
    server.bye('The host stopped the game.');
    await settle();
    expect(bye).toHaveBeenCalledWith('The host stopped the game.');
    await expect(client.call('get', null)).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a call that times out', async () => {
    const [guestSide, hostSide] = channelPair();
    rpcServer(hostSide, () => new Promise(() => {})); // never answers
    const client = rpcClient(guestSide);
    vi.useFakeTimers();
    const slow = client.call('get', null);
    vi.advanceTimersByTime(10_001);
    await expect(slow).rejects.toMatchObject({ status: 504 });
  });

  it('rejects pending calls when the channel closes', async () => {
    const [guestSide, hostSide] = channelPair();
    rpcServer(hostSide, () => new Promise(() => {}));
    const client = rpcClient(guestSide);
    const pending = client.call('get', null);
    guestSide.close();
    await expect(pending).rejects.toMatchObject({ status: 503 });
  });

  it('closes on a malformed message from the guest', async () => {
    const [guestSide, hostSide] = channelPair();
    const closed = vi.fn();
    guestSide.onClose(closed);
    rpcServer(hostSide, async () => ({}));
    guestSide.send({ t: 'call', id: -1, method: 'get', args: null });
    await settle();
    expect(closed).toHaveBeenCalled();
  });

  it('closes on a malformed message from the host', async () => {
    const [guestSide, hostSide] = channelPair();
    const closed = vi.fn();
    rpcClient(guestSide);
    hostSide.onClose(closed);
    hostSide.send({ t: 'result', id: 'x', view: null });
    await settle();
    expect(closed).toHaveBeenCalled();
  });
});

// The messages between a Nearby host and its guests. A guest calls a session method on the host;
// the host answers with the guest's view of the session, or with an error. The host also tells
// every guest when the session changed, gives the link of each finished game, and says goodbye when it stops.
// Both sides check every message, because the other device is not trusted. The host checks the
// arguments of each method with the protocol parsers (src/protocol.ts); here they stay unknown.
import { isRecord } from '../guards.ts';
import { type GameId, parseGameId } from '../protocol.ts';
import type { Channel } from './peer.ts';

const RPC_METHODS = ['get', 'join', 'move', 'newGame', 'update', 'lock', 'chat', 'seat', 'answerSeat'] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

type GuestMessage = { t: 'call'; id: number; method: RpcMethod; args: unknown };
type HostMessage =
  | { t: 'result'; id: number; view: unknown }
  | { t: 'error'; id: number; status: number; message: string }
  | { t: 'changed' }
  // The public id of a finished game, so a guest shares the host's game link (it names both players).
  | { t: 'link'; game: number; id: GameId }
  | { t: 'bye'; reason: string };

const CALL_TIMEOUT_MS = 10_000;
const BYE_CLOSE_DELAY_MS = 250;
const MAX_TEXT_LENGTH = 500;

// An error the host sends back for one call. `status` follows HTTP: 4xx for a refused call.
export class RpcError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const hasKeys = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;

export function parseGuestMessage(value: unknown): GuestMessage | undefined {
  if (!isRecord(value) || value.t !== 'call' || !hasKeys(value, ['t', 'id', 'method', 'args'])) return undefined;
  const method = RPC_METHODS.find((known) => known === value.method);
  if (!isId(value.id) || method === undefined) return undefined;
  return { t: 'call', id: value.id, method, args: value.args };
}

export function parseHostMessage(value: unknown): HostMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.t) {
    case 'result':
      return hasKeys(value, ['t', 'id', 'view']) && isId(value.id) ? { t: 'result', id: value.id, view: value.view } : undefined;
    case 'error': {
      const { id, status, message } = value;
      const valid =
        hasKeys(value, ['t', 'id', 'status', 'message']) &&
        isId(id) &&
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599 &&
        isText(message);
      return valid ? { t: 'error', id, status, message } : undefined;
    }
    case 'changed':
      return hasKeys(value, ['t']) ? { t: 'changed' } : undefined;
    case 'link': {
      // Only a device game id (8 characters) fits: a Nearby game has no session code on the server.
      const id = parseGameId(value.id);
      const game = value.game;
      const valid =
        hasKeys(value, ['t', 'game', 'id']) &&
        typeof game === 'number' &&
        Number.isSafeInteger(game) &&
        game >= 0 &&
        id !== undefined &&
        id === value.id &&
        !id.includes('-');
      return valid ? { t: 'link', game, id } : undefined;
    }
    case 'bye':
      return hasKeys(value, ['t', 'reason']) && isText(value.reason) ? { t: 'bye', reason: value.reason } : undefined;
    default:
      return undefined;
  }
}

// Guest side. Each call resolves with the host's answer, or rejects on an error, a timeout or a closed channel.
export function rpcClient(channel: Channel) {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve(view: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const changedHandlers = new Set<() => void>();
  const linkHandlers: ((game: number, id: GameId) => void)[] = [];
  const byeHandlers: ((reason: string) => void)[] = [];

  const failAll = (error: Error) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };

  channel.onMessage((value) => {
    const message = parseHostMessage(value);
    // A host that sends garbage is broken or hostile, so the guest stops talking to it.
    if (message === undefined) return channel.close();
    if (message.t === 'changed') {
      for (const handler of changedHandlers) handler();
      return;
    }
    if (message.t === 'link') {
      for (const handler of linkHandlers) handler(message.game, message.id);
      return;
    }
    if (message.t === 'bye') {
      failAll(new RpcError(503, message.reason));
      for (const handler of byeHandlers) handler(message.reason);
      return channel.close();
    }
    const call = pending.get(message.id);
    if (call === undefined) return; // an answer after its timeout
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.t === 'result') call.resolve(message.view);
    else call.reject(new RpcError(message.status, message.message));
  });
  channel.onClose(() => {
    closed = true;
    failAll(new RpcError(503, 'The connection to the host closed.'));
  });

  return {
    call(method: RpcMethod, args: unknown): Promise<unknown> {
      if (closed) return Promise.reject(new RpcError(503, 'The connection to the host closed.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RpcError(504, 'The host did not answer.'));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          channel.send({ t: 'call', id, method, args } satisfies GuestMessage);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    // Returns a function that removes the handler.
    onChanged(handler: () => void): () => void {
      changedHandlers.add(handler);
      return () => changedHandlers.delete(handler);
    },
    onLink(handler: (game: number, id: GameId) => void): void {
      linkHandlers.push(handler);
    },
    onBye(handler: (reason: string) => void): void {
      byeHandlers.push(handler);
    },
  };
}

// Host side. `handle` runs one call and returns the guest's view. An error with a numeric 4xx
// `status` goes back to the guest as it is; any other error goes back as a generic host error.
export function rpcServer(channel: Channel, handle: (method: RpcMethod, args: unknown) => Promise<unknown>) {
  const send = (message: HostMessage) => {
    try {
      channel.send(message);
    } catch {
      // The guest left. Its channel's close handlers clean up.
    }
  };

  // After a goodbye the host ignores the guest, while the close waits.
  let leaving = false;
  // Closing at once can drop the goodbye that is still in the send queue, so the close waits a moment.
  const bye = (reason: string): void => {
    if (leaving) return;
    leaving = true;
    send({ t: 'bye', reason: reason.slice(0, MAX_TEXT_LENGTH) });
    setTimeout(() => channel.close(), BYE_CLOSE_DELAY_MS);
  };

  channel.onMessage((value) => {
    if (leaving) return;
    const message = parseGuestMessage(value);
    if (message === undefined) return bye('The host received an invalid message.');
    handle(message.method, message.args).then(
      (view) => send({ t: 'result', id: message.id, view }),
      (error: unknown) => {
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
        const refused = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500;
        if (refused && error instanceof Error) {
          send({ t: 'error', id: message.id, status, message: error.message.slice(0, MAX_TEXT_LENGTH) });
        } else {
          console.error('Nearby host error:', error);
          send({ t: 'error', id: message.id, status: 500, message: 'The host had an error.' });
        }
      },
    );
  });

  return {
    notifyChanged(): void {
      send({ t: 'changed' });
    },
    link(game: number, id: GameId): void {
      send({ t: 'link', game, id });
    },
    bye,
  };
}
